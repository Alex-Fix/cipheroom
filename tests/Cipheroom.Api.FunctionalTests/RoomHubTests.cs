using System.Net;
using Cipheroom.Api.Hubs.Contracts;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using static Cipheroom.Api.FunctionalTests.TestCall;

namespace Cipheroom.Api.FunctionalTests;

/// <summary>
/// The SignalR contract as clients see it. These tests pin today's behaviour, including exact error messages,
/// so internal restructuring can't change the protocol (docs/signaling-protocol.md).
/// </summary>
public sealed class RoomHubTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory = factory.WithWebHostBuilder(b => b
        .UseSetting("Turn:Cloudflare:KeyId", "")
        .UseSetting("Turn:Cloudflare:ApiToken", "")
        .UseSetting("RateLimiting:Hub:TokenLimit", "1000")
        .UseSetting("RateLimiting:Hub:TokensPerSecond", "1000"));

    [Fact]
    public async Task Participants_are_notified_of_joins_and_leaves()
    {
        var room = new TestRoom();
        await using var alice = await ConnectAsync();
        var joined = Events<ParticipantDto>(alice, "ParticipantJoined");
        var left = Events<string>(alice, "ParticipantLeft");

        var host = await room.HostAsync(alice);
        Assert.True(host.Join.Admitted);
        Assert.Empty(host.Join.Participants);

        var bob = await ConnectAsync();
        var guest = await room.AdmitAsync(host, bob);

        var bobAsSeenByAlice = await joined.ReadAsync(Timeout());
        Assert.Equal(guest.SelfId, bobAsSeenByAlice.Id);
        Assert.Equal(guest.Identity.Identity, bobAsSeenByAlice.Identity);
        Assert.Equal(new TicketDto(host.Identity.Pub, room.TicketFor(host, guest.Identity)), bobAsSeenByAlice.Ticket);
        var aliceAsSeenByBob = Assert.Single(guest.Join.Participants);
        Assert.Equal(host.SelfId, aliceAsSeenByBob.Id);
        Assert.Null(aliceAsSeenByBob.Ticket); // the host key attests the host

        await bob.DisposeAsync();
        Assert.Equal(guest.SelfId, await left.ReadAsync(Timeout()));
    }

    [Fact]
    public async Task LeaveRoom_notifies_others_and_allows_joining_again()
    {
        var room = new TestRoom();
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        var left = Events<string>(alice, "ParticipantLeft");
        var host = await room.HostAsync(alice);
        var guest = await room.AdmitAsync(host, bob);

        await bob.InvokeAsync("LeaveRoom", Ct);
        Assert.Equal(guest.SelfId, await left.ReadAsync(Timeout()));

        var rejoin = await new TestRoom().HostAsync(bob);
        Assert.Empty(rejoin.Join.Participants);
    }

    [Fact]
    public async Task Participant_ids_are_random_hex_not_connection_ids()
    {
        await using var connection = await ConnectAsync();
        var join = await new TestRoom().HostAsync(connection);

        Assert.Matches("^[0-9a-f]{16}$", join.SelfId);
        Assert.NotEqual(connection.ConnectionId, join.SelfId);
    }

    [Fact]
    public async Task Rtc_config_requires_joining_and_has_no_relay_when_turn_is_unconfigured()
    {
        await using var connection = await ConnectAsync();
        await AssertHubErrorAsync("Join a room first.", () => connection.InvokeAsync<RtcConfig>("GetRtcConfig", Ct));

        await new TestRoom().HostAsync(connection);
        var config = await connection.InvokeAsync<RtcConfig>("GetRtcConfig", Ct);

        Assert.Empty(config.IceServers);
        Assert.False(config.ForceRelay);
    }

    [Theory]
    [InlineData("room-1")] // the old random format: those links don't work anymore
    [InlineData("UPPERCASEUPPERCASEUPPERCAS")]
    [InlineData("ab")]
    [InlineData(null)]
    public async Task Invalid_room_id_is_rejected(string? roomId)
    {
        await using var connection = await ConnectAsync();
        await AssertHubErrorAsync(
            "Invalid room id.",
            () => connection.InvokeAsync<LobbyResult>("JoinLobby", roomId, TestIdentity.Dto, TestIdentity.Codecs, null, null, Ct));
    }

    [Fact]
    public async Task Video_codecs_are_relayed_to_the_others()
    {
        var room = new TestRoom();
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        var joined = Events<ParticipantDto>(alice, "ParticipantJoined");

        var host = await room.HostAsync(alice, ["vp9", "vp8"]);
        var guest = await room.AdmitAsync(host, bob, ["vp8"]);

        // Canonical order, whatever order the client sent.
        Assert.Equal(["vp8", "vp9"], Assert.Single(guest.Join.Participants).VideoCodecs);
        Assert.Equal(["vp8"], (await joined.ReadAsync(Timeout())).VideoCodecs);
    }

    [Theory]
    [InlineData("vp9")]
    [InlineData("vp8,h264")]
    [InlineData("vp8,av1")]
    public async Task Invalid_video_codecs_are_rejected(string codecs)
    {
        var room = new TestRoom();
        await using var connection = await ConnectAsync();
        await AssertHubErrorAsync(
            "Invalid video codecs.",
            () => connection.InvokeAsync<LobbyResult>("JoinLobby", room.Id, TestIdentity.Dto, codecs.Split(','), null, null, Ct));
        await AssertHubErrorAsync(
            "Invalid video codecs.",
            () => connection.InvokeAsync<LobbyResult>("JoinLobby", room.Id, TestIdentity.Dto, null, null, null, Ct));
    }

    [Fact]
    public async Task Old_clients_cannot_join()
    {
        var room = new TestRoom();
        await using var connection = await ConnectAsync();
        // JoinRoom is gone (it let anyone with the link straight in and sent names in plaintext).
        await Assert.ThrowsAsync<HubException>(
            () => connection.InvokeAsync<LobbyResult>("JoinRoom", room.Id, "Old", TestIdentity.Dto, TestIdentity.Codecs, Ct));
        // Clients that leave arguments out fail SignalR's argument binding.
        await Assert.ThrowsAsync<HubException>(
            () => connection.InvokeAsync<LobbyResult>("JoinLobby", room.Id, TestIdentity.Dto, TestIdentity.Codecs, Ct));
        await AssertHubErrorAsync("Join a room first.", () => connection.InvokeAsync<RtcConfig>("GetRtcConfig", Ct));
    }

    [Fact]
    public async Task Joining_twice_is_rejected()
    {
        await using var connection = await ConnectAsync();
        await new TestRoom().HostAsync(connection);
        await AssertHubErrorAsync("Already in a room.", () => new TestRoom().HostAsync(connection));
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
}
