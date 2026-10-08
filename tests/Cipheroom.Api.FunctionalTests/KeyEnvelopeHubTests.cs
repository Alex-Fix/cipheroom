using System.Threading.Channels;
using Cipheroom.Api.Hubs.Contracts;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using static Cipheroom.Api.FunctionalTests.TestCall;

namespace Cipheroom.Api.FunctionalTests;

/// <summary>
/// End-to-end key signaling as clients see it (docs/signaling-protocol.md): identities are required and relayed,
/// envelopes reach their recipient only, and never leave the room.
/// </summary>
public sealed class KeyEnvelopeHubTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory = factory.WithWebHostBuilder(b => b
        .UseSetting("Turn:Cloudflare:KeyId", "")
        .UseSetting("Turn:Cloudflare:ApiToken", ""));

    [Fact]
    public async Task Identities_are_relayed_to_everyone_in_the_room()
    {
        var room = new TestRoom();
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        var joined = Events<ParticipantDto>(alice, "ParticipantJoined");

        var host = await room.HostAsync(alice);
        var guest = await room.AdmitAsync(host, bob);

        Assert.Equal(guest.Identity.Identity, (await joined.ReadAsync(Timeout())).Identity);
        Assert.Equal(host.Identity.Identity, Assert.Single(guest.Join.Participants).Identity);
    }

    [Fact]
    public async Task Joining_without_a_valid_identity_is_rejected()
    {
        var room = new TestRoom();
        await using var connection = await ConnectAsync();
        await AssertHubErrorAsync(
            "Invalid identity.",
            () => connection.InvokeAsync<LobbyResult>("JoinLobby", room.Id, null, TestIdentity.Codecs, null, null, Ct));
        await AssertHubErrorAsync(
            "Invalid identity.",
            () => connection.InvokeAsync<LobbyResult>("JoinLobby", room.Id, TestIdentity.Dto with { Sig = "short" }, TestIdentity.Codecs, null, null, Ct));
    }

    [Fact]
    public async Task Envelopes_reach_their_recipient_only_with_the_sender_set_by_the_server()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        await using var carol = await ConnectAsync();
        var bobInbox = Inbox(bob);
        var carolInbox = Inbox(carol);
        var (aliceJoin, bobJoin, carolJoin) = await ThreeInARoomAsync(alice, bob, carol);

        await alice.InvokeAsync("SendKeyEnvelopes", new[] { new KeyEnvelopeDto(bobJoin.SelfId, "Zm9yLWJvYg") }, Ct);
        Assert.Equal((aliceJoin.SelfId, "Zm9yLWJvYg"), await bobInbox.ReadAsync(Timeout()));

        // Sent after Bob's: if Carol had received Bob's envelope, it would come first.
        await alice.InvokeAsync("SendKeyEnvelopes", new[] { new KeyEnvelopeDto(carolJoin.SelfId, "Zm9yLWNhcm9s") }, Ct);
        Assert.Equal((aliceJoin.SelfId, "Zm9yLWNhcm9s"), await carolInbox.ReadAsync(Timeout()));
        Assert.False(bobInbox.TryRead(out _));
    }

    [Fact]
    public async Task One_call_delivers_a_whole_rotation()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        await using var carol = await ConnectAsync();
        var bobInbox = Inbox(bob);
        var carolInbox = Inbox(carol);
        var (_, bobJoin, carolJoin) = await ThreeInARoomAsync(alice, bob, carol);

        await alice.InvokeAsync(
            "SendKeyEnvelopes",
            new[] { new KeyEnvelopeDto(bobJoin.SelfId, "Ym9i"), new KeyEnvelopeDto(carolJoin.SelfId, "Y2Fyb2w") },
            Ct);

        Assert.Equal("Ym9i", (await bobInbox.ReadAsync(Timeout())).Blob);
        Assert.Equal("Y2Fyb2w", (await carolInbox.ReadAsync(Timeout())).Blob);
    }

    [Fact]
    public async Task Envelopes_never_leave_the_room()
    {
        await using var alice = await ConnectAsync();
        await using var mallory = await ConnectAsync();
        var aliceInbox = Inbox(alice);

        var aliceJoin = await new TestRoom().HostAsync(alice);
        await new TestRoom().HostAsync(mallory);

        await AssertHubErrorAsync(
            "Invalid key envelope.",
            () => mallory.InvokeAsync("SendKeyEnvelopes", new[] { new KeyEnvelopeDto(aliceJoin.SelfId, "aGk") }, Ct));
        Assert.False(aliceInbox.TryRead(out _));
    }

    [Fact]
    public async Task Malformed_envelopes_and_sending_before_joining_are_rejected()
    {
        await using var connection = await ConnectAsync();
        await AssertHubErrorAsync(
            "Join a room first.",
            () => connection.InvokeAsync("SendKeyEnvelopes", new[] { new KeyEnvelopeDto("0123456789abcdef", "aGk") }, Ct));

        var join = await new TestRoom().HostAsync(connection);
        await AssertHubErrorAsync(
            "Invalid key envelope.",
            () => connection.InvokeAsync("SendKeyEnvelopes", new[] { new KeyEnvelopeDto(join.SelfId, "aGk") }, Ct));
        await AssertHubErrorAsync(
            "Invalid key envelope.",
            () => connection.InvokeAsync("SendKeyEnvelopes", new[] { new KeyEnvelopeDto("0123456789abcdef", new string('A', 2049)) }, Ct));
        await AssertHubErrorAsync(
            "Invalid key envelope.",
            () => connection.InvokeAsync("SendKeyEnvelopes", Array.Empty<KeyEnvelopeDto>(), Ct));
    }

    private static async Task<(TestMember, TestMember, TestMember)> ThreeInARoomAsync(HubConnection alice, HubConnection bob, HubConnection carol)
    {
        var room = new TestRoom();
        var host = await room.HostAsync(alice);
        return (host, await room.AdmitAsync(host, bob), await room.AdmitAsync(host, carol));
    }

    private static ChannelReader<(string FromId, string Blob)> Inbox(HubConnection connection)
    {
        var inbox = Channel.CreateUnbounded<(string, string)>();
        connection.On<string, string>("KeyEnvelopeReceived", (from, blob) => inbox.Writer.TryWrite((from, blob)));
        return inbox.Reader;
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
