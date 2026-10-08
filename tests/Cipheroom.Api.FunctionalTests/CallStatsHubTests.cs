using Cipheroom.Api.Hubs.Contracts;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;

namespace Cipheroom.Api.FunctionalTests;

/// <summary>ReportCallStats as clients see it (docs/signaling-protocol.md): members only, validated, no reply.</summary>
public sealed class CallStatsHubTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory = factory.WithWebHostBuilder(b => b
        .UseSetting("Turn:Cloudflare:KeyId", "")
        .UseSetting("Turn:Cloudflare:ApiToken", ""));

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly CallStatsDto Report = new(
        "desktop-firefox", "relay", 15, 35,
        AudioSent: new StreamStatsDto(60_000, 750, 0, null, null, null, null),
        AudioReceived: new StreamStatsDto(58_000, 740, 3, 8, null, null, null),
        VideoSent: null,
        VideoReceived: new StreamStatsDto(4_000_000, 3500, 10, 15, 0, 720, 30),
        E2ee: new E2eeStatsDto(750, 4240, 0, 0, 0, 0));

    [Fact]
    public async Task Participants_can_report_call_quality()
    {
        await using var connection = await ConnectAsync();
        await new TestRoom().HostAsync(connection);

        await connection.InvokeAsync("ReportCallStats", Report, Ct);
    }

    [Fact]
    public async Task Reports_require_joining_and_a_valid_shape()
    {
        await using var connection = await ConnectAsync();
        await AssertHubErrorAsync("Join a room first.", () => connection.InvokeAsync("ReportCallStats", Report, Ct));

        await new TestRoom().HostAsync(connection);
        await AssertHubErrorAsync("Invalid stats.", () => connection.InvokeAsync("ReportCallStats", Report with { IntervalSeconds = 0 }, Ct));
        await AssertHubErrorAsync("Invalid stats.", () =>
            connection.InvokeAsync("ReportCallStats", Report with { VideoReceived = Report.VideoReceived! with { Height = 99_999 } }, Ct));
        await AssertHubErrorAsync("Invalid stats.", () => connection.InvokeAsync("ReportCallStats", (CallStatsDto?)null, Ct));
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
