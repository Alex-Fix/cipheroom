using System.Threading.Channels;
using Cipheroom.Api.Hubs.Contracts;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;

namespace Cipheroom.Api.Tests;

public sealed class RoomHubTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory = factory.WithWebHostBuilder(b => b
        .UseSetting("LiveKit:Url", "ws://livekit.test")
        .UseSetting("LiveKit:ApiKey", "testkey")
        .UseSetting("LiveKit:ApiSecret", "test-secret-that-is-at-least-32-bytes-long")
        .UseSetting("Turn:Cloudflare:KeyId", "")
        .UseSetting("Turn:Cloudflare:ApiToken", ""));

    [Fact]
    public async Task Participants_are_notified_of_joins_and_leaves()
    {
        await using var alice = await ConnectAsync();
        var joined = Channel.CreateUnbounded<ParticipantDto>();
        var left = Channel.CreateUnbounded<string>();
        alice.On<ParticipantDto>("ParticipantJoined", p => joined.Writer.TryWrite(p));
        alice.On<string>("ParticipantLeft", id => left.Writer.TryWrite(id));

        var aliceJoin = await alice.InvokeAsync<JoinResult>("JoinRoom", "room-1", "Alice");
        Assert.Empty(aliceJoin.Participants);

        var bob = await ConnectAsync();
        var bobJoin = await bob.InvokeAsync<JoinResult>("JoinRoom", "room-1", "  Bob ");

        var bobAsSeenByAlice = await joined.Reader.ReadAsync(Timeout());
        Assert.Equal(new ParticipantDto(bobJoin.SelfId, "Bob"), bobAsSeenByAlice);
        Assert.Equal([new ParticipantDto(aliceJoin.SelfId, "Alice")], bobJoin.Participants);

        await bob.DisposeAsync();
        Assert.Equal(bobJoin.SelfId, await left.Reader.ReadAsync(Timeout()));
    }

    [Fact]
    public async Task Rtc_config_requires_joining_and_returns_token_without_relay_when_turn_unconfigured()
    {
        await using var connection = await ConnectAsync();

        await Assert.ThrowsAsync<HubException>(() => connection.InvokeAsync<RtcConfig>("GetRtcConfig"));

        await connection.InvokeAsync<JoinResult>("JoinRoom", "room-2", "Carol");
        var config = await connection.InvokeAsync<RtcConfig>("GetRtcConfig");

        Assert.Equal("ws://livekit.test", config.LivekitUrl);
        Assert.NotEmpty(config.Token);
        Assert.Empty(config.IceServers);
        Assert.False(config.ForceRelay);
    }

    [Theory]
    [InlineData("UPPER", "Dave")]
    [InlineData("ab", "Dave")]
    [InlineData("room-3", "")]
    [InlineData("room-3", "   ")]
    public async Task Invalid_join_input_is_rejected(string roomId, string displayName)
    {
        await using var connection = await ConnectAsync();
        await Assert.ThrowsAsync<HubException>(() => connection.InvokeAsync<JoinResult>("JoinRoom", roomId, displayName));
    }

    [Fact]
    public async Task Joining_twice_is_rejected()
    {
        await using var connection = await ConnectAsync();
        await connection.InvokeAsync<JoinResult>("JoinRoom", "room-4", "Eve");
        await Assert.ThrowsAsync<HubException>(() => connection.InvokeAsync<JoinResult>("JoinRoom", "room-5", "Eve"));
    }

    private async Task<HubConnection> ConnectAsync()
    {
        var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(_factory.Server.BaseAddress, "hubs/room"), o =>
            {
                o.Transports = HttpTransportType.LongPolling;
                o.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
            })
            .Build();
        await connection.StartAsync();
        return connection;
    }

    private static CancellationToken Timeout() => new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token;
}
