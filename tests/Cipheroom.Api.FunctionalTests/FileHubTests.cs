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
/// Data channels for encrypted files as clients see them (docs/signaling-protocol.md), against a fake media server:
/// only channels published in the caller's room can be received, by members, under owner-prefixed SFU names.
/// </summary>
public sealed class FileHubTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private const string Name = "AAAAAAAAAAAAAAAAAAAAAA";

    private readonly MediaHubTests.FakeSfu _sfu = new();

    private WebApplicationFactory<Program> Host => factory.WithWebHostBuilder(b => b
        .UseSetting("Turn:Cloudflare:KeyId", "")
        .UseSetting("Turn:Cloudflare:ApiToken", "")
        .UseSetting("RateLimiting:Hub:TokenLimit", "1000")
        .UseSetting("RateLimiting:Hub:TokensPerSecond", "1000")
        .ConfigureTestServices(s => s.AddSingleton<ISfu>(_sfu)));

    [Fact]
    public async Task A_member_publishes_and_another_receives_through_the_publisher_s_session()
    {
        var host = Host;
        await using var alice = await ConnectAsync(host);
        await using var bob = await ConnectAsync(host);
        var room = new TestRoom();
        var aliceJoin = await room.HostAsync(alice);
        await room.AdmitAsync(aliceJoin, bob);

        var transport = await alice.InvokeAsync<DataTransportDto>("OpenDataTransport", Ct);
        Assert.Equal(MediaHubTests.FakeSfu.DataTransportOffer, transport.OfferSdp);
        await alice.InvokeAsync("Renegotiate", "v=0 answer", Ct);
        var published = await alice.InvokeAsync<DataChannelDto>("PublishDataChannel", Name, Ct);

        await bob.InvokeAsync<DataTransportDto>("OpenDataTransport", Ct);
        var received = await bob.InvokeAsync<DataChannelDto>("SubscribeDataChannel", aliceJoin.SelfId, Name, Ct);

        Assert.NotEqual(published.ChannelId, received.ChannelId);
        var (session, publisher, sfuName) = Assert.Single(_sfu.SubscribedDataChannels);
        Assert.NotEqual(session, publisher);
        Assert.Equal($"{aliceJoin.SelfId}-{Name}", sfuName);

        await alice.InvokeAsync("CloseDataChannel", Name, null, Ct);
        Assert.Contains(_sfu.ClosedDataChannels, c => c.Id == published.ChannelId);
        Assert.Contains(_sfu.ClosedDataChannels, c => c.Id == received.ChannelId);
    }

    [Fact]
    public async Task Channels_in_another_room_are_invalid()
    {
        var host = Host;
        await using var alice = await ConnectAsync(host);
        await using var mallory = await ConnectAsync(host);
        var aliceJoin = await new TestRoom().HostAsync(alice);
        await alice.InvokeAsync<DataTransportDto>("OpenDataTransport", Ct);
        await alice.InvokeAsync<DataChannelDto>("PublishDataChannel", Name, Ct);
        await new TestRoom().HostAsync(mallory);
        await mallory.InvokeAsync<DataTransportDto>("OpenDataTransport", Ct);

        await AssertHubErrorAsync("Invalid data channel.", () => mallory.InvokeAsync<DataChannelDto>("SubscribeDataChannel", aliceJoin.SelfId, Name, Ct));
        Assert.Empty(_sfu.SubscribedDataChannels);
    }

    [Fact]
    public async Task Inputs_and_order_are_checked()
    {
        var host = Host;
        await using var alice = await ConnectAsync(host);
        await using var guest = await ConnectAsync(host);
        var room = new TestRoom();
        await room.HostAsync(alice);
        await room.WaitAsync(guest);

        await AssertHubErrorAsync("Open the data transport first.", () => alice.InvokeAsync<DataChannelDto>("PublishDataChannel", Name, Ct));
        await AssertHubErrorAsync("Invalid data channel.", () => alice.InvokeAsync<DataChannelDto>("PublishDataChannel", "../etc", Ct));
        await alice.InvokeAsync<DataTransportDto>("OpenDataTransport", Ct);
        await AssertHubErrorAsync("Data transport already open.", () => alice.InvokeAsync<DataTransportDto>("OpenDataTransport", Ct));
        await AssertHubErrorAsync("Not admitted.", () => guest.InvokeAsync<DataTransportDto>("OpenDataTransport", Ct));

        await using var stranger = await ConnectAsync(host);
        await AssertHubErrorAsync("Join a room first.", () => stranger.InvokeAsync<DataTransportDto>("OpenDataTransport", Ct));
    }

    private static async Task AssertHubErrorAsync(string expectedMessage, Func<Task> call)
    {
        var error = await Assert.ThrowsAsync<HubException>(call);
        Assert.EndsWith($"HubException: {expectedMessage}", error.Message, StringComparison.Ordinal);
    }

    private static async Task<HubConnection> ConnectAsync(WebApplicationFactory<Program> host)
    {
        var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(host.Server.BaseAddress, "hubs/room"), o =>
            {
                o.Transports = HttpTransportType.LongPolling;
                o.HttpMessageHandlerFactory = _ => host.Server.CreateHandler();
            })
            .Build();
        await connection.StartAsync(Ct);
        return connection;
    }
}
