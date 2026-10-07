using System.Threading.Channels;
using Cipheroom.Api.Hubs.Contracts;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;

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

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Identities_are_relayed_to_everyone_in_the_room()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        var joined = Channel.CreateUnbounded<ParticipantDto>();
        alice.On<ParticipantDto>("ParticipantJoined", p => joined.Writer.TryWrite(p));
        var bobIdentity = TestIdentity.Dto with { X25519Pub = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWY" };

        await alice.InvokeAsync<JoinResult>("JoinRoom", "keys-1", "Alice", TestIdentity.Dto, Ct);
        var bobJoin = await bob.InvokeAsync<JoinResult>("JoinRoom", "keys-1", "Bob", bobIdentity, Ct);

        Assert.Equal(bobIdentity, (await joined.Reader.ReadAsync(Timeout())).Identity);
        Assert.Equal(TestIdentity.Dto, Assert.Single(bobJoin.Participants).Identity);
    }

    [Fact]
    public async Task Joining_without_a_valid_identity_is_rejected()
    {
        await using var connection = await ConnectAsync();
        await AssertHubErrorAsync(
            "Invalid identity.",
            () => connection.InvokeAsync<JoinResult>("JoinRoom", "keys-2", "Alice", null, Ct));
        await AssertHubErrorAsync(
            "Invalid identity.",
            () => connection.InvokeAsync<JoinResult>("JoinRoom", "keys-2", "Alice", TestIdentity.Dto with { Sig = "short" }, Ct));
    }

    [Fact]
    public async Task Clients_that_send_no_identity_argument_cannot_join()
    {
        await using var connection = await ConnectAsync();
        // Pre-E2EE clients called JoinRoom(roomId, displayName): they must never end up in a call unencrypted.
        await Assert.ThrowsAsync<HubException>(() => connection.InvokeAsync<JoinResult>("JoinRoom", "keys-3", "Old", Ct));
        await AssertHubErrorAsync("Join a room first.", () => connection.InvokeAsync<RtcConfig>("GetRtcConfig", Ct));
    }

    [Fact]
    public async Task Envelopes_reach_their_recipient_only_with_the_sender_set_by_the_server()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        await using var carol = await ConnectAsync();
        var bobInbox = Inbox(bob);
        var carolInbox = Inbox(carol);

        var aliceJoin = await alice.InvokeAsync<JoinResult>("JoinRoom", "keys-4", "Alice", TestIdentity.Dto, Ct);
        var bobJoin = await bob.InvokeAsync<JoinResult>("JoinRoom", "keys-4", "Bob", TestIdentity.Dto, Ct);
        var carolJoin = await carol.InvokeAsync<JoinResult>("JoinRoom", "keys-4", "Carol", TestIdentity.Dto, Ct);

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

        await alice.InvokeAsync<JoinResult>("JoinRoom", "keys-5", "Alice", TestIdentity.Dto, Ct);
        var bobJoin = await bob.InvokeAsync<JoinResult>("JoinRoom", "keys-5", "Bob", TestIdentity.Dto, Ct);
        var carolJoin = await carol.InvokeAsync<JoinResult>("JoinRoom", "keys-5", "Carol", TestIdentity.Dto, Ct);

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

        var aliceJoin = await alice.InvokeAsync<JoinResult>("JoinRoom", "keys-6", "Alice", TestIdentity.Dto, Ct);
        await mallory.InvokeAsync<JoinResult>("JoinRoom", "keys-elsewhere", "Mallory", TestIdentity.Dto, Ct);

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

        var join = await connection.InvokeAsync<JoinResult>("JoinRoom", "keys-7", "Alice", TestIdentity.Dto, Ct);
        await AssertHubErrorAsync(
            "Invalid key envelope.",
            () => connection.InvokeAsync("SendKeyEnvelopes", new[] { new KeyEnvelopeDto(join.SelfId, "aGk") }, Ct));
        await AssertHubErrorAsync(
            "Invalid key envelope.",
            () => connection.InvokeAsync("SendKeyEnvelopes", new[] { new KeyEnvelopeDto("0123456789abcdef", new string('A', 1025)) }, Ct));
        await AssertHubErrorAsync(
            "Invalid key envelope.",
            () => connection.InvokeAsync("SendKeyEnvelopes", Array.Empty<KeyEnvelopeDto>(), Ct));
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

    private static CancellationToken Timeout() =>
        CancellationTokenSource.CreateLinkedTokenSource(Ct, new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token).Token;
}
