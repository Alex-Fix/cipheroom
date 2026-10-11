using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;
using Cipheroom.Infrastructure.Rtc.LiveKit;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;

namespace Cipheroom.Infrastructure.IntegrationTests.Rtc;

public sealed class LiveKitTests
{
    private const string Secret = "0123456789abcdef0123456789abcdef";
    private static readonly RoomId Room = new("k3fqz2abcdefghijklmnopqrst");
    private static readonly ParticipantId Bob = new("0011223344556677");
    private readonly FakeTimeProvider _time = new(DateTimeOffset.FromUnixTimeSeconds(1_800_000_000));
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    // --- tokens --------------------------------------------------------------------------------------------------------

    [Fact]
    public void Participant_tokens_are_signed_and_limited_to_the_room()
    {
        var token = Tokens().Participant(Room, Bob);

        var payload = Verify(token);
        Assert.Equal("api-key", payload.GetProperty("iss").GetString());
        Assert.Equal(Bob.Value, payload.GetProperty("sub").GetString());
        Assert.Equal(1_800_000_000 + 600, payload.GetProperty("exp").GetInt64());
        var video = payload.GetProperty("video");
        Assert.Equal(Room.Value, video.GetProperty("room").GetString());
        Assert.True(video.GetProperty("roomJoin").GetBoolean());
        Assert.True(video.GetProperty("canPublishData").GetBoolean());
        Assert.False(video.TryGetProperty("roomAdmin", out _));
    }

    [Fact]
    public void Admin_tokens_administer_one_room_only_briefly()
    {
        var video = Verify(Tokens().RoomAdmin(Room)).GetProperty("video");

        Assert.True(video.GetProperty("roomAdmin").GetBoolean());
        Assert.Equal(Room.Value, video.GetProperty("room").GetString());
        Assert.False(video.TryGetProperty("roomJoin", out _));
    }

    // --- server API ----------------------------------------------------------------------------------------------------

    [Fact]
    public async Task Removing_a_participant_calls_the_room_service_with_an_admin_token()
    {
        var handler = new StubHandler(HttpStatusCode.OK);
        await Client(handler).RemoveParticipantAsync(Room.Value, Bob.Value, "admin-token", _ct);

        var request = Assert.Single(handler.Requests);
        Assert.Equal("http://livekit:7880/twirp/livekit.RoomService/RemoveParticipant", request.Uri);
        Assert.Equal("Bearer admin-token", request.Authorization);
        Assert.Equal($$"""{"room":"{{Room.Value}}","identity":"{{Bob.Value}}"}""", request.Body);
    }

    [Fact]
    public async Task Gone_already_is_fine_and_other_failures_are_media_server_errors()
    {
        await Client(new StubHandler(HttpStatusCode.NotFound)).DeleteRoomAsync(Room.Value, "t", _ct);
        await Assert.ThrowsAsync<MediaServerException>(() => Client(new StubHandler(HttpStatusCode.Unauthorized)).DeleteRoomAsync(Room.Value, "t", _ct));
        var unreachable = new LiveKitRoomServiceClient(new HttpClient { BaseAddress = new Uri("http://127.0.0.1:9/") });
        await Assert.ThrowsAsync<MediaServerException>(() => unreachable.DeleteRoomAsync(Room.Value, "t", _ct));
    }

    // --- relay ---------------------------------------------------------------------------------------------------------

    [Fact]
    public async Task Relays_both_ways_with_a_server_token_and_only_the_allowed_parameters()
    {
        await using var server = await FakeLiveKit.StartAsync();
        var sink = new RecordingSink();
        using var relay = Relay(server.Url, sink);
        var owner = new MediaRelayOwner("conn-b", Room, Bob);

        await relay.OpenAsync(owner, "0123456789abcdef", "/rtc/v1", "join_request=AAAA&sdk=js&access_token=placeholder&evil=1", _ct);
        await relay.SendAsync("conn-b", "0123456789abcdef", new byte[] { 1, 2, 3 }, text: false, _ct);
        var echoed = await sink.NextMessage();

        Assert.Equal("/rtc/v1", server.Path);
        Assert.Equal("AAAA", server.Query["join_request"]);
        Assert.Equal("js", server.Query["sdk"]);
        Assert.False(server.Query.ContainsKey("evil"));
        Assert.Equal(Bob.Value, Verify(server.Query["access_token"]!).GetProperty("sub").GetString()); // not the placeholder
        Assert.Equal(("conn-b", "0123456789abcdef", false), (echoed.ConnectionId, echoed.RelayId, echoed.Text));
        Assert.Equal([9, 1, 2, 3], echoed.Message);
    }

    [Fact]
    public async Task A_close_from_livekit_reaches_the_browser_and_frees_the_relay()
    {
        await using var server = await FakeLiveKit.StartAsync();
        var sink = new RecordingSink();
        using var relay = Relay(server.Url, sink);
        var owner = new MediaRelayOwner("conn-b", Room, Bob);
        await relay.OpenAsync(owner, "0123456789abcdef", "/rtc/v1", "", _ct);

        await relay.SendAsync("conn-b", "0123456789abcdef", "close"u8.ToArray(), text: true, _ct);

        var (connection, relayId, code) = await sink.NextClose();
        Assert.Equal(("conn-b", "0123456789abcdef", 1000), (connection, relayId, code));
        // Freed: the same id can be opened again.
        await relay.OpenAsync(owner, "0123456789abcdef", "/rtc/v1", "", _ct);
    }

    [Fact]
    public async Task At_most_two_relays_per_connection_and_ids_are_unique()
    {
        await using var server = await FakeLiveKit.StartAsync();
        using var relay = Relay(server.Url, new RecordingSink());
        var owner = new MediaRelayOwner("conn-b", Room, Bob);

        await relay.OpenAsync(owner, "000000000000000a", "/rtc/v1", "", _ct);
        await Assert.ThrowsAsync<DomainException>(() => relay.OpenAsync(owner, "000000000000000a", "/rtc/v1", "", _ct));
        await relay.OpenAsync(owner, "000000000000000b", "/rtc/v1", "", _ct);
        await Assert.ThrowsAsync<DomainException>(() => relay.OpenAsync(owner, "000000000000000c", "/rtc/v1", "", _ct));

        await relay.CloseConnectionAsync("conn-b");
        await relay.OpenAsync(owner, "000000000000000c", "/rtc/v1", "", _ct);
    }

    [Fact]
    public async Task Ending_the_room_closes_its_relays_and_tells_the_browsers()
    {
        await using var server = await FakeLiveKit.StartAsync();
        var sink = new RecordingSink();
        using var relay = Relay(server.Url, sink);
        await relay.OpenAsync(new MediaRelayOwner("conn-b", Room, Bob), "0123456789abcdef", "/rtc/v1", "", _ct);

        await relay.CloseRoomAsync(Room);

        Assert.Equal(("conn-b", "0123456789abcdef", 1000), await sink.NextClose());
    }

    [Fact]
    public async Task An_unreachable_server_is_a_media_server_error()
    {
        using var relay = Relay("http://127.0.0.1:9", new RecordingSink());
        await Assert.ThrowsAsync<MediaServerException>(() =>
            relay.OpenAsync(new MediaRelayOwner("conn-b", Room, Bob), "0123456789abcdef", "/rtc/v1", "", _ct));
    }

    // --- helpers -------------------------------------------------------------------------------------------------------

    private LiveKitTokens Tokens(string url = "http://livekit:7880") => new(Options.Create(new LiveKitOptions { Url = url, ApiKey = "api-key", ApiSecret = Secret }), _time);

    private static LiveKitRelay Relay(string url, IMediaRelaySink sink) =>
        new(Options.Create(new LiveKitOptions { Url = url, ApiKey = "api-key", ApiSecret = Secret }), new LiveKitTokens(Options.Create(new LiveKitOptions { ApiKey = "api-key", ApiSecret = Secret }), TimeProvider.System), sink, NullLogger<LiveKitRelay>.Instance);

    private static LiveKitRoomServiceClient Client(HttpMessageHandler handler) => new(new HttpClient(handler) { BaseAddress = new Uri("http://livekit:7880/") });

    /// <summary>Checks the HS256 signature with the secret and returns the payload.</summary>
    private static JsonElement Verify(string token)
    {
        var parts = token.Split('.');
        Assert.Equal(3, parts.Length);
        var expected = Convert.ToBase64String(HMACSHA256.HashData(Encoding.UTF8.GetBytes(Secret), Encoding.ASCII.GetBytes($"{parts[0]}.{parts[1]}")))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        Assert.Equal(expected, parts[2]);
        return JsonDocument.Parse(FromBase64Url(parts[1])).RootElement;
    }

    private static byte[] FromBase64Url(string s) => Convert.FromBase64String(s.Replace('-', '+').Replace('_', '/').PadRight(s.Length + (4 - s.Length % 4) % 4, '='));

    private sealed record Recorded(string Uri, string? Authorization, string? Body);

    private sealed class StubHandler(HttpStatusCode status) : HttpMessageHandler
    {
        public List<Recorded> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(new(request.RequestUri!.AbsoluteUri, request.Headers.Authorization?.ToString(),
                request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken)));
            return new HttpResponseMessage(status) { Content = new StringContent("{}", Encoding.UTF8, "application/json") };
        }
    }

    private sealed class RecordingSink : IMediaRelaySink
    {
        private readonly BlockingCollection<(string ConnectionId, string RelayId, byte[] Message, bool Text)> _messages = [];
        private readonly BlockingCollection<(string, string, int)> _closes = [];

        public Task ReceivedAsync(string connectionId, string relayId, ReadOnlyMemory<byte> message, bool text, CancellationToken cancellationToken)
        {
            _messages.Add((connectionId, relayId, message.ToArray(), text), cancellationToken);
            return Task.CompletedTask;
        }

        public Task ClosedAsync(string connectionId, string relayId, int code)
        {
            _closes.Add((connectionId, relayId, code));
            return Task.CompletedTask;
        }

        public Task<(string ConnectionId, string RelayId, byte[] Message, bool Text)> NextMessage() => Task.Run(() => Take(_messages));

        public Task<(string, string, int)> NextClose() => Task.Run(() => Take(_closes));

        private static T Take<T>(BlockingCollection<T> items) =>
            items.TryTake(out var item, TimeSpan.FromSeconds(5)) ? item : throw new TimeoutException("Nothing arrived.");
    }

    /// <summary>A WebSocket server standing in for LiveKit: echoes binary messages prefixed with 9, closes on "close".</summary>
    private sealed class FakeLiveKit : IAsyncDisposable
    {
        private readonly WebApplication _app;

        private FakeLiveKit(WebApplication app) => _app = app;

        public string Url { get; private set; } = "";

        public string? Path { get; private set; }

        public Dictionary<string, string?> Query { get; private set; } = [];

        public static async Task<FakeLiveKit> StartAsync()
        {
            var builder = WebApplication.CreateSlimBuilder();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            var app = builder.Build();
            var fake = new FakeLiveKit(app);
            app.UseWebSockets();
            app.Map("/rtc/v1", async (HttpContext context) =>
            {
                fake.Path = context.Request.Path;
                fake.Query = context.Request.Query.ToDictionary(q => q.Key, q => (string?)q.Value.ToString());
                using var socket = await context.WebSockets.AcceptWebSocketAsync();
                var buffer = new byte[4096];
                while (socket.State == WebSocketState.Open)
                {
                    var received = await socket.ReceiveAsync(buffer, CancellationToken.None);
                    if (received.MessageType == WebSocketMessageType.Close)
                        break;
                    if (received.MessageType == WebSocketMessageType.Text && Encoding.UTF8.GetString(buffer, 0, received.Count) == "close")
                    {
                        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None);
                        break;
                    }
                    await socket.SendAsync((byte[])[9, .. buffer.AsSpan(0, received.Count)], received.MessageType, true, CancellationToken.None);
                }
            });
            await app.StartAsync();
            fake.Url = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
            return fake;
        }

        public async ValueTask DisposeAsync()
        {
            await _app.StopAsync();
            await _app.DisposeAsync();
        }
    }
}
