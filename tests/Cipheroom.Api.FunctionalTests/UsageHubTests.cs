using Cipheroom.Api.Hubs.Contracts;
using Cipheroom.Application.Common.Interfaces;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using static Cipheroom.Api.FunctionalTests.TestCall;

namespace Cipheroom.Api.FunctionalTests;

/// <summary>
/// The usage guard as clients see it (docs/plans/2026-10-09-usage-guard-design.md): everyone learns the level on
/// connect and on change, new calls stop at audio-only, video stops flowing, and pausing ends calls.
/// </summary>
public sealed class UsageHubTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly TestUsageGuard _usage = new();
    private readonly TestRoom _room = new();

    private WebApplicationFactory<Program> Host => field ??= factory.WithWebHostBuilder(b => b
        .UseSetting("Turn:Cloudflare:KeyId", "")
        .UseSetting("Turn:Cloudflare:ApiToken", "")
        .UseSetting("RateLimiting:Hub:TokenLimit", "1000")
        .UseSetting("RateLimiting:Hub:TokensPerSecond", "1000")
        .ConfigureTestServices(s => s
            .AddSingleton<IUsageGuard>(_usage)
            .AddSingleton<ISfu>(new MediaHubTests.FakeSfu())));

    [Fact]
    public async Task Everyone_learns_the_level_on_connect_with_no_percent_at_normal()
    {
        var connection = Connection();
        var usage = Events<UsageDto>(connection, "UsageChanged");
        await connection.StartAsync(Ct);

        var first = await usage.ReadAsync(Timeout());
        Assert.Equal(("normal", (int?)null), (first.Level, first.Percent));
        await connection.DisposeAsync();
    }

    [Fact]
    public async Task At_audio_only_no_new_call_or_guest_gets_in_but_reconnects_do()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        await using var carol = await ConnectAsync();
        await using var dave = await ConnectAsync();
        var host = await _room.HostAsync(alice);
        var guest = await _room.AdmitAsync(host, bob);
        await bob.InvokeAsync("LeaveRoom", Ct);

        _usage.Set(UsageLevel.AudioOnly);

        await AssertHubErrorAsync("Calls are paused.", () => new TestRoom().HostAsync(dave));
        await AssertHubErrorAsync("Calls are paused.", () => _room.WaitAsync(carol));
        var back = await bob.InvokeAsync<LobbyResult>("JoinLobby", _room.Id, guest.Identity.Identity, TestIdentity.Codecs, null, guest.Join.Ticket, Ct);
        Assert.True(back.Admitted);
    }

    [Fact]
    public async Task At_audio_only_subscribing_gets_audio_only()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        var host = await _room.HostAsync(alice);
        await _room.AdmitAsync(host, bob);
        await alice.InvokeAsync<AnswerDto>("PublishTracks", "v=0 offer",
            new[] { new PublishTrackDto("0", "microphone"), new PublishTrackDto("1", "camera") }, Ct);

        _usage.Set(UsageLevel.AudioOnly);
        var result = await bob.InvokeAsync<SubscribeResult>("SubscribeTracks",
            new[] { new TrackRefDto(host.SelfId, "microphone"), new TrackRefDto(host.SelfId, "camera") }, Ct);

        Assert.Equal(["microphone"], result.Tracks.Select(t => t.Source));
    }

    [Fact]
    public async Task A_new_level_reaches_everyone_and_pausing_ends_calls()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        await using var stranger = await ConnectAsync();
        var bobUsage = Events<UsageDto>(bob, "UsageChanged");
        var strangerUsage = Events<UsageDto>(stranger, "UsageChanged");
        var host = await _room.HostAsync(alice);
        await _room.AdmitAsync(host, bob);

        _usage.Set(UsageLevel.Paused, 99);

        var forBob = await NextAsync(bobUsage, u => u.Level == "paused");
        Assert.Equal(99, forBob.Percent);
        Assert.Equal(TestUsageGuard.ResetsAt, forBob.ResetsAt);
        await NextAsync(strangerUsage, u => u.Level == "paused");
        await AssertHubErrorAsync("Join a room first.", () => alice.InvokeAsync<RtcConfig>("GetRtcConfig", Ct));
        await AssertHubErrorAsync("Join a room first.", () => bob.InvokeAsync<RtcConfig>("GetRtcConfig", Ct));
        await AssertHubErrorAsync("Calls are paused.", () => _room.HostAsync(stranger));
    }

    private static async Task<T> NextAsync<T>(System.Threading.Channels.ChannelReader<T> events, Func<T, bool> match)
    {
        var timeout = Timeout();
        while (true)
        {
            var next = await events.ReadAsync(timeout);
            if (match(next))
                return next;
        }
    }

    private static async Task AssertHubErrorAsync(string expectedMessage, Func<Task> call)
    {
        var error = await Assert.ThrowsAsync<HubException>(call);
        Assert.EndsWith($"HubException: {expectedMessage}", error.Message, StringComparison.Ordinal);
    }

    private HubConnection Connection() =>
        new HubConnectionBuilder()
            .WithUrl(new Uri(Host.Server.BaseAddress, "hubs/room"), o =>
            {
                o.Transports = HttpTransportType.LongPolling;
                o.HttpMessageHandlerFactory = _ => Host.Server.CreateHandler();
            })
            .Build();

    private async Task<HubConnection> ConnectAsync()
    {
        var connection = Connection();
        await connection.StartAsync(Ct);
        return connection;
    }

    /// <summary>A usage guard the test moves between levels.</summary>
    private sealed class TestUsageGuard : IUsageGuard
    {
        public static readonly DateTimeOffset ResetsAt = new(2026, 11, 1, 0, 0, 0, TimeSpan.Zero);

        public UsageStatus Current { get; private set; } = new(UsageLevel.Normal, null, ResetsAt);

        public event Action<UsageStatus>? Changed;

        public void Set(UsageLevel level, int percent = 96)
        {
            Current = new UsageStatus(level, level == UsageLevel.Normal ? null : percent, ResetsAt);
            Changed?.Invoke(Current);
        }
    }
}
