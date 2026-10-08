using System.Net;
using System.Threading.Channels;
using Cipheroom.Api.Hubs.Contracts;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;

namespace Cipheroom.Api.FunctionalTests;

/// <summary>
/// The SignalR contract as clients see it. These tests pin today's behaviour, including exact error messages,
/// so internal restructuring can't change the protocol (docs/signaling-protocol.md).
/// </summary>
public sealed class RoomHubTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory = factory.WithWebHostBuilder(b => b
        .UseSetting("Turn:Cloudflare:KeyId", "")
        .UseSetting("Turn:Cloudflare:ApiToken", ""));

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Participants_are_notified_of_joins_and_leaves()
    {
        await using var alice = await ConnectAsync();
        var joined = Channel.CreateUnbounded<ParticipantDto>();
        var left = Channel.CreateUnbounded<string>();
        alice.On<ParticipantDto>("ParticipantJoined", p => joined.Writer.TryWrite(p));
        alice.On<string>("ParticipantLeft", id => left.Writer.TryWrite(id));

        var aliceJoin = await alice.InvokeAsync<JoinResult>("JoinRoom", "room-1", "Alice", TestIdentity.Dto, TestIdentity.Codecs, Ct);
        Assert.Empty(aliceJoin.Participants);

        var bob = await ConnectAsync();
        var bobJoin = await bob.InvokeAsync<JoinResult>("JoinRoom", "room-1", "  Bob ", TestIdentity.Dto, TestIdentity.Codecs, Ct);

        var bobAsSeenByAlice = await joined.Reader.ReadAsync(Timeout());
        Assert.Equal((bobJoin.SelfId, "Bob"), (bobAsSeenByAlice.Id, bobAsSeenByAlice.DisplayName));
        Assert.Empty(bobAsSeenByAlice.Tracks);
        var aliceAsSeenByBob = Assert.Single(bobJoin.Participants);
        Assert.Equal((aliceJoin.SelfId, "Alice"), (aliceAsSeenByBob.Id, aliceAsSeenByBob.DisplayName));

        await bob.DisposeAsync();
        Assert.Equal(bobJoin.SelfId, await left.Reader.ReadAsync(Timeout()));
    }

    [Fact]
    public async Task LeaveRoom_notifies_others_and_allows_joining_again()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        var left = Channel.CreateUnbounded<string>();
        alice.On<string>("ParticipantLeft", id => left.Writer.TryWrite(id));

        await alice.InvokeAsync<JoinResult>("JoinRoom", "room-leave", "Alice", TestIdentity.Dto, TestIdentity.Codecs, Ct);
        var bobJoin = await bob.InvokeAsync<JoinResult>("JoinRoom", "room-leave", "Bob", TestIdentity.Dto, TestIdentity.Codecs, Ct);

        await bob.InvokeAsync("LeaveRoom", Ct);
        Assert.Equal(bobJoin.SelfId, await left.Reader.ReadAsync(Timeout()));

        var rejoin = await bob.InvokeAsync<JoinResult>("JoinRoom", "room-leave-2", "Bob", TestIdentity.Dto, TestIdentity.Codecs, Ct);
        Assert.Empty(rejoin.Participants);
    }

    [Fact]
    public async Task Participant_ids_are_random_hex_not_connection_ids()
    {
        await using var connection = await ConnectAsync();
        var join = await connection.InvokeAsync<JoinResult>("JoinRoom", "room-ids", "Alice", TestIdentity.Dto, TestIdentity.Codecs, Ct);

        Assert.Matches("^[0-9a-f]{16}$", join.SelfId);
        Assert.NotEqual(connection.ConnectionId, join.SelfId);
    }

    [Fact]
    public async Task Rtc_config_requires_joining_and_has_no_relay_when_turn_is_unconfigured()
    {
        await using var connection = await ConnectAsync();

        await AssertHubErrorAsync("Join a room first.", () => connection.InvokeAsync<RtcConfig>("GetRtcConfig", Ct));

        await connection.InvokeAsync<JoinResult>("JoinRoom", "room-2", "Carol", TestIdentity.Dto, TestIdentity.Codecs, Ct);
        var config = await connection.InvokeAsync<RtcConfig>("GetRtcConfig", Ct);

        Assert.Empty(config.IceServers);
        Assert.False(config.ForceRelay);
    }

    [Theory]
    [InlineData("UPPER")]
    [InlineData("ab")]
    [InlineData("room id")]
    [InlineData(null)]
    public async Task Invalid_room_id_is_rejected(string? roomId)
    {
        await using var connection = await ConnectAsync();
        await AssertHubErrorAsync(
            "Invalid room id.",
            () => connection.InvokeAsync<JoinResult>("JoinRoom", roomId, "Dave", TestIdentity.Dto, TestIdentity.Codecs, Ct));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public async Task Invalid_display_name_is_rejected(string? displayName)
    {
        await using var connection = await ConnectAsync();
        await AssertHubErrorAsync(
            "Display name must be 1-64 characters.",
            () => connection.InvokeAsync<JoinResult>("JoinRoom", "room-3", displayName, TestIdentity.Dto, TestIdentity.Codecs, Ct));
    }

    [Fact]
    public async Task Display_name_longer_than_64_characters_is_rejected()
    {
        await using var connection = await ConnectAsync();
        await AssertHubErrorAsync(
            "Display name must be 1-64 characters.",
            () => connection.InvokeAsync<JoinResult>("JoinRoom", "room-3", new string('a', 65), TestIdentity.Dto, TestIdentity.Codecs, Ct));
    }

    [Fact]
    public async Task Video_codecs_are_relayed_to_the_others()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        var joined = Channel.CreateUnbounded<ParticipantDto>();
        alice.On<ParticipantDto>("ParticipantJoined", p => joined.Writer.TryWrite(p));

        await alice.InvokeAsync<JoinResult>("JoinRoom", "room-codecs", "Alice", TestIdentity.Dto, "av1,vp8".Split(','), Ct);
        var bobJoin = await bob.InvokeAsync<JoinResult>("JoinRoom", "room-codecs", "Bob", TestIdentity.Dto, "vp8,vp9".Split(','), Ct);

        // Canonical order, whatever order the client sent.
        Assert.Equal(["vp8", "av1"], Assert.Single(bobJoin.Participants).VideoCodecs);
        Assert.Equal(["vp8", "vp9"], (await joined.Reader.ReadAsync(Timeout())).VideoCodecs);
    }

    [Theory]
    [InlineData("vp9")]
    [InlineData("vp8,h264")]
    public async Task Invalid_video_codecs_are_rejected(string codecs)
    {
        await using var connection = await ConnectAsync();
        await AssertHubErrorAsync(
            "Invalid video codecs.",
            () => connection.InvokeAsync<JoinResult>("JoinRoom", "room-3", "Dave", TestIdentity.Dto, codecs.Split(','), Ct));
        await AssertHubErrorAsync(
            "Invalid video codecs.",
            () => connection.InvokeAsync<JoinResult>("JoinRoom", "room-3", "Dave", TestIdentity.Dto, null, Ct));
    }

    [Fact]
    public async Task Clients_that_send_no_codecs_argument_cannot_join()
    {
        await using var connection = await ConnectAsync();
        // Clients from before codec selection: they'd be sent codecs they can't decode.
        await Assert.ThrowsAsync<HubException>(
            () => connection.InvokeAsync<JoinResult>("JoinRoom", "room-old", "Old", TestIdentity.Dto, Ct));
        await AssertHubErrorAsync("Join a room first.", () => connection.InvokeAsync<RtcConfig>("GetRtcConfig", Ct));
    }

    [Fact]
    public async Task Joining_twice_is_rejected()
    {
        await using var connection = await ConnectAsync();
        await connection.InvokeAsync<JoinResult>("JoinRoom", "room-4", "Eve", TestIdentity.Dto, TestIdentity.Codecs, Ct);
        await AssertHubErrorAsync(
            "Already in a room.",
            () => connection.InvokeAsync<JoinResult>("JoinRoom", "room-5", "Eve", TestIdentity.Dto, TestIdentity.Codecs, Ct));
    }

    [Fact]
    public async Task Health_endpoint_reports_healthy()
    {
        using var client = _factory.CreateClient();
        var response = await client.GetAsync(new Uri("/healthz", UriKind.Relative), Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("Healthy", await response.Content.ReadAsStringAsync(Ct));
    }

    /// <summary>SignalR surfaces server HubExceptions as "...HubException: {message}" on the client.</summary>
    private static async Task AssertHubErrorAsync(string expectedMessage, Func<Task> call)
    {
        var error = await Assert.ThrowsAsync<HubException>(call);
        Assert.EndsWith($"HubException: {expectedMessage}", error.Message, StringComparison.Ordinal);
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
        await connection.StartAsync(Ct);
        return connection;
    }

    private static CancellationToken Timeout() =>
        CancellationTokenSource.CreateLinkedTokenSource(Ct, new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token).Token;
}
