using System.Threading.Channels;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using static Cipheroom.Api.FunctionalTests.TestCall;

namespace Cipheroom.Api.FunctionalTests;

/// <summary>
/// Encrypted chat as clients see it (docs/signaling-protocol.md): one opaque event reaches everyone else in the room,
/// with the sender set by the server — never the sender itself, another room, or the lobby.
/// </summary>
public sealed class ChatHubTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory = factory.WithWebHostBuilder(b => b
        .UseSetting("Turn:Cloudflare:KeyId", "")
        .UseSetting("Turn:Cloudflare:ApiToken", ""));

    [Fact]
    public async Task A_chat_event_reaches_everyone_else_in_the_room_with_the_sender_set_by_the_server()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        await using var carol = await ConnectAsync();
        var aliceInbox = Inbox(alice);
        var bobInbox = Inbox(bob);
        var carolInbox = Inbox(carol);
        var room = new TestRoom();
        var host = await room.HostAsync(alice);
        await room.AdmitAsync(host, bob);
        await room.AdmitAsync(host, carol);

        await alice.InvokeAsync("SendChat", "aGVsbG8", Ct);

        Assert.Equal((host.SelfId, "aGVsbG8"), await bobInbox.ReadAsync(Timeout()));
        Assert.Equal((host.SelfId, "aGVsbG8"), await carolInbox.ReadAsync(Timeout()));
        Assert.False(aliceInbox.TryRead(out _));
    }

    [Fact]
    public async Task Chat_never_leaves_the_room_or_reaches_the_lobby()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        await using var guest = await ConnectAsync();
        await using var stranger = await ConnectAsync();
        var bobInbox = Inbox(bob);
        var guestInbox = Inbox(guest);
        var strangerInbox = Inbox(stranger);
        var room = new TestRoom();
        var host = await room.HostAsync(alice);
        await room.AdmitAsync(host, bob);
        await room.WaitAsync(guest);
        await new TestRoom().HostAsync(stranger);

        await alice.InvokeAsync("SendChat", "aGk", Ct);

        // Bob's copy arriving means the others would have arrived too.
        Assert.Equal("aGk", (await bobInbox.ReadAsync(Timeout())).Blob);
        Assert.False(guestInbox.TryRead(out _));
        Assert.False(strangerInbox.TryRead(out _));
    }

    [Fact]
    public async Task Lobby_guests_cannot_chat()
    {
        await using var alice = await ConnectAsync();
        await using var guest = await ConnectAsync();
        var aliceInbox = Inbox(alice);
        var room = new TestRoom();
        await room.HostAsync(alice);
        await room.WaitAsync(guest);

        await AssertHubErrorAsync("Not admitted.", () => guest.InvokeAsync("SendChat", "aGk", Ct));
        Assert.False(aliceInbox.TryRead(out _));
    }

    [Fact]
    public async Task Malformed_events_and_sending_before_joining_are_rejected()
    {
        await using var connection = await ConnectAsync();
        await AssertHubErrorAsync("Join a room first.", () => connection.InvokeAsync("SendChat", "aGk", Ct));

        await new TestRoom().HostAsync(connection);
        await AssertHubErrorAsync("Invalid chat message.", () => connection.InvokeAsync("SendChat", (string?)null, Ct));
        await AssertHubErrorAsync("Invalid chat message.", () => connection.InvokeAsync("SendChat", "not base64url!", Ct));
        await AssertHubErrorAsync("Invalid chat message.", () => connection.InvokeAsync("SendChat", new string('A', 22529), Ct));
    }

    private static ChannelReader<(string FromId, string Blob)> Inbox(HubConnection connection)
    {
        var inbox = Channel.CreateUnbounded<(string, string)>();
        connection.On<string, string>("ChatReceived", (from, blob) => inbox.Writer.TryWrite((from, blob)));
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
