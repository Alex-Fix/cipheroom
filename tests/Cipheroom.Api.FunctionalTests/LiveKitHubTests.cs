using System.Collections.Concurrent;
using System.Threading.Channels;
using Cipheroom.Api.Hubs.Contracts;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using static Cipheroom.Api.FunctionalTests.TestCall;

namespace Cipheroom.Api.FunctionalTests;

/// <summary>
/// LiveKit mode as clients see it (docs/plans/2026-10-11-livekit-media-mode-design.md): the signaling relay and
/// announced tracks. The relay to the LiveKit server is faked; it pushes messages back through the real hub sink.
/// </summary>
public sealed class LiveKitHubTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private const string RelayId = "0123456789abcdef";
    private static readonly string[] MicAndCamera = ["microphone", "camera"];
    private static readonly string[] CameraOnly = ["camera"];

    private readonly FakeRelay _relay = new();

    private WebApplicationFactory<Program> LiveKit() => factory.WithWebHostBuilder(b => b
        .UseSetting("Turn:Cloudflare:KeyId", "")
        .UseSetting("Turn:Cloudflare:ApiToken", "")
        .UseSetting("Media:Provider", "LiveKit")
        .UseSetting("LiveKit:ApiKey", "test-key")
        .UseSetting("LiveKit:ApiSecret", "0123456789abcdef0123456789abcdef")
        .ConfigureTestServices(s => s.AddSingleton<IMediaRelay>(sp => _relay.With(sp.GetRequiredService<IMediaRelaySink>()))));

    private WebApplicationFactory<Program> Cloudflare() => factory.WithWebHostBuilder(b => b
        .UseSetting("Turn:Cloudflare:KeyId", "")
        .UseSetting("Turn:Cloudflare:ApiToken", ""));

    [Fact]
    public async Task Rtc_config_names_livekit()
    {
        var app = LiveKit();
        await using var alice = await ConnectAsync(app);
        await new TestRoom().HostAsync(alice);

        var config = await alice.InvokeAsync<RtcConfig>("GetRtcConfig", Ct);

        Assert.Equal("livekit", config.Provider);
        Assert.Empty(config.IceServers);
    }

    [Fact]
    public async Task Members_open_relays_for_their_own_room_and_identity_and_messages_flow_both_ways()
    {
        var app = LiveKit();
        await using var alice = await ConnectAsync(app);
        var received = Channel.CreateUnbounded<(string, string, bool)>();
        alice.On<string, string, bool>("MediaRelayReceived", (id, message, text) => received.Writer.TryWrite((id, message, text)));
        var room = new TestRoom();
        var host = await room.HostAsync(alice);

        await alice.InvokeAsync("OpenMediaRelay", RelayId, "/rtc/v1", "join_request=AAAA", Ct);
        await alice.InvokeAsync("SendMediaRelay", RelayId, Convert.ToBase64String([1, 2, 3]), false, Ct);
        await _relay.Push(RelayId, [7, 8], text: false);

        var opened = Assert.Single(_relay.Opened);
        Assert.Equal((room.RoomId, new ParticipantId(host.SelfId), RelayId, "/rtc/v1", "join_request=AAAA"),
            (opened.Owner.RoomId, opened.Owner.ParticipantId, opened.RelayId, opened.Path, opened.Query));
        Assert.Equal([1, 2, 3], Assert.Single(_relay.Sent).Message);
        Assert.Equal((RelayId, Convert.ToBase64String([7, 8]), false), await received.Reader.ReadAsync(Timeout()));
    }

    [Fact]
    public async Task A_relay_closed_upstream_is_reported_to_its_owner()
    {
        var app = LiveKit();
        await using var alice = await ConnectAsync(app);
        var closed = Channel.CreateUnbounded<(string, int)>();
        alice.On<string, int>("MediaRelayClosed", (id, code) => closed.Writer.TryWrite((id, code)));
        await new TestRoom().HostAsync(alice);
        await alice.InvokeAsync("OpenMediaRelay", RelayId, "/rtc/v1", "", Ct);

        await _relay.CloseUpstream(RelayId, 1011);

        Assert.Equal((RelayId, 1011), await closed.Reader.ReadAsync(Timeout()));
    }

    [Fact]
    public async Task Knocking_guests_and_strangers_get_no_relay()
    {
        var app = LiveKit();
        await using var alice = await ConnectAsync(app);
        await using var guest = await ConnectAsync(app);
        await using var stranger = await ConnectAsync(app);
        var room = new TestRoom();
        await room.HostAsync(alice);
        await room.WaitAsync(guest);

        await AssertHubErrorAsync("Not admitted.", () => guest.InvokeAsync("OpenMediaRelay", RelayId, "/rtc/v1", "", Ct));
        await AssertHubErrorAsync("Join a room first.", () => stranger.InvokeAsync("OpenMediaRelay", RelayId, "/rtc/v1", "", Ct));
        Assert.Empty(_relay.Opened);
    }

    [Fact]
    public async Task Leaving_closes_the_connections_relays()
    {
        var app = LiveKit();
        await using var alice = await ConnectAsync(app);
        await new TestRoom().HostAsync(alice);
        var connectionId = alice.ConnectionId;

        await alice.InvokeAsync("LeaveRoom", Ct);

        Assert.Contains(connectionId!, _relay.ClosedConnections);
    }

    [Fact]
    public async Task Announced_tracks_reach_everyone_else_like_a_publish()
    {
        var app = LiveKit();
        await using var alice = await ConnectAsync(app);
        await using var bob = await ConnectAsync(app);
        var published = Channel.CreateUnbounded<(string, IReadOnlyList<TrackDto>)>();
        bob.On<string, IReadOnlyList<TrackDto>>("TracksPublished", (id, tracks) => published.Writer.TryWrite((id, tracks)));
        var room = new TestRoom();
        var host = await room.HostAsync(alice);
        await room.AdmitAsync(host, bob);

        await alice.InvokeAsync("AnnounceTracks", MicAndCamera, Ct);

        var (from, tracks) = await published.Reader.ReadAsync(Timeout());
        Assert.Equal(host.SelfId, from);
        Assert.Equal(["microphone", "camera"], tracks.Select(t => t.Source));
    }

    [Fact]
    public async Task Cloudflare_negotiation_is_refused_in_livekit_mode()
    {
        var app = LiveKit();
        await using var alice = await ConnectAsync(app);
        await new TestRoom().HostAsync(alice);

        await AssertHubErrorAsync("Not available in this media mode.",
            () => alice.InvokeAsync<AnswerDto>("PublishTracks", "v=0\r\n", new[] { new PublishTrackDto("0", "microphone") }, Ct));
        await AssertHubErrorAsync("Not available in this media mode.", () => alice.InvokeAsync<DataTransportDto>("OpenDataTransport", Ct));
    }

    [Fact]
    public async Task Relays_and_announcements_are_refused_on_cloudflare()
    {
        var app = Cloudflare();
        await using var alice = await ConnectAsync(app);
        await new TestRoom().HostAsync(alice);

        await AssertHubErrorAsync("Not available in this media mode.", () => alice.InvokeAsync("OpenMediaRelay", RelayId, "/rtc/v1", "", Ct));
        await AssertHubErrorAsync("Not available in this media mode.", () => alice.InvokeAsync("AnnounceTracks", CameraOnly, Ct));
    }

    [Fact]
    public async Task Relayed_signaling_has_its_own_rate_budget()
    {
        var app = LiveKit();
        await using var alice = await ConnectAsync(app);
        await new TestRoom().HostAsync(alice);
        await alice.InvokeAsync("OpenMediaRelay", RelayId, "/rtc/v1", "", Ct);

        // Far beyond the general budget (20 at once): a connect's ICE candidates come in a burst.
        for (var i = 0; i < 60; i++)
            await alice.InvokeAsync("SendMediaRelay", RelayId, "AQ==", false, Ct);

        Assert.Equal(60, _relay.Sent.Count);
    }

    [Fact]
    public async Task Malformed_relay_input_is_refused()
    {
        var app = LiveKit();
        await using var alice = await ConnectAsync(app);
        await new TestRoom().HostAsync(alice);

        await AssertHubErrorAsync("Invalid media relay.", () => alice.InvokeAsync("OpenMediaRelay", "short", "/rtc/v1", "", Ct));
        await AssertHubErrorAsync("Invalid media relay.", () => alice.InvokeAsync("OpenMediaRelay", RelayId, "/twirp/x", "", Ct));
        await AssertHubErrorAsync("Invalid media relay.", () => alice.InvokeAsync("SendMediaRelay", RelayId, "not base64!", false, Ct));
    }

    private static async Task AssertHubErrorAsync(string expectedMessage, Func<Task> call)
    {
        var error = await Assert.ThrowsAsync<HubException>(call);
        Assert.EndsWith($"HubException: {expectedMessage}", error.Message, StringComparison.Ordinal);
    }

    private static async Task<HubConnection> ConnectAsync(WebApplicationFactory<Program> app)
    {
        var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(app.Server.BaseAddress, "hubs/room"), o =>
            {
                o.Transports = HttpTransportType.LongPolling;
                o.HttpMessageHandlerFactory = _ => app.Server.CreateHandler();
            })
            .Build();
        await connection.StartAsync(Ct);
        return connection;
    }

    private sealed record Open(MediaRelayOwner Owner, string RelayId, string Path, string Query);

    private sealed record Message(string ConnectionId, string RelayId, byte[] Bytes);

    /// <summary>Records what the hub asks of the relay; pushes "LiveKit" messages through the hub's sink.</summary>
    private sealed class FakeRelay : IMediaRelay
    {
        private IMediaRelaySink? _sink;
        private readonly ConcurrentDictionary<string, string> _owners = new();

        public ConcurrentQueue<Open> Opened { get; } = new();

        public ConcurrentQueue<(string RelayId, byte[] Message)> Sent { get; } = new();

        public ConcurrentQueue<string> ClosedConnections { get; } = new();

        public FakeRelay With(IMediaRelaySink sink)
        {
            _sink = sink;
            return this;
        }

        public Task OpenAsync(MediaRelayOwner owner, string relayId, string path, string query, CancellationToken cancellationToken)
        {
            Opened.Enqueue(new(owner, relayId, path, query));
            _owners[relayId] = owner.ConnectionId;
            return Task.CompletedTask;
        }

        public Task SendAsync(string connectionId, string relayId, ReadOnlyMemory<byte> message, bool text, CancellationToken cancellationToken)
        {
            Sent.Enqueue((relayId, message.ToArray()));
            return Task.CompletedTask;
        }

        public Task CloseAsync(string connectionId, string relayId) => Task.CompletedTask;

        public Task CloseConnectionAsync(string connectionId)
        {
            ClosedConnections.Enqueue(connectionId);
            return Task.CompletedTask;
        }

        public Task CloseRoomAsync(RoomId room) => Task.CompletedTask;

        public Task Push(string relayId, byte[] message, bool text) => _sink!.ReceivedAsync(_owners[relayId], relayId, message, text, CancellationToken.None);

        public Task CloseUpstream(string relayId, int code) => _sink!.ClosedAsync(_owners[relayId], relayId, code);
    }
}
