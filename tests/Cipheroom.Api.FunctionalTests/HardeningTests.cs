using System.Net;
using Cipheroom.Api.Hubs.Contracts;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Cipheroom.Api.FunctionalTests;

public sealed class HardeningTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory = factory.WithWebHostBuilder(b => b
        // Tiny bucket that doesn't refill during the test.
        .UseSetting("RateLimiting:Hub:TokenLimit", "2")
        .UseSetting("RateLimiting:Hub:TokensPerSecond", "1")
        .UseSetting("ForwardedHeaders:KnownNetworks:0", "172.16.0.0/12"));

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Hub_calls_are_rate_limited_per_connection()
    {
        await using var flooder = await ConnectAsync();
        await new TestRoom().HostAsync(flooder);
        await flooder.InvokeAsync<RtcConfig>("GetRtcConfig", Ct);

        var error = await Assert.ThrowsAsync<HubException>(() => flooder.InvokeAsync<RtcConfig>("GetRtcConfig", Ct));
        Assert.EndsWith("HubException: Too many requests.", error.Message, StringComparison.Ordinal);

        // Other connections have their own bucket.
        await using var neighbour = await ConnectAsync();
        await neighbour.InvokeAsync<LobbyResult>("JoinLobby", new TestRoom().Id, TestIdentity.Dto, TestIdentity.Codecs, null, null, Ct);
    }

    [Fact]
    public void Forwarded_headers_trust_only_configured_proxy_networks()
    {
        var options = _factory.Services.GetRequiredService<IOptions<ForwardedHeadersOptions>>().Value;

        Assert.Null(options.ForwardLimit);
        Assert.Contains(options.KnownIPNetworks, n => n.Contains(IPAddress.Parse("172.18.0.5")));
        Assert.DoesNotContain(options.KnownIPNetworks, n => n.Contains(IPAddress.Parse("203.0.113.7")));
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
