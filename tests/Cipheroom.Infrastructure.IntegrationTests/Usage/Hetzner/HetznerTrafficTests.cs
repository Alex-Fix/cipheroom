using System.Net;
using System.Text;
using Cipheroom.Application;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Infrastructure.Usage;
using Cipheroom.Infrastructure.Usage.Cloudflare;
using Cipheroom.Infrastructure.Usage.Hetzner;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Time.Testing;

namespace Cipheroom.Infrastructure.IntegrationTests.Usage.Hetzner;

/// <summary>LiveKit mode on Hetzner: the server's own traffic is what costs money (docs/plans/2026-10-11-livekit-media-mode-design.md).</summary>
public sealed class HetznerTrafficTests
{
    private const long TB = 1_000_000_000_000;
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 10, 12, 10, 0, 0, TimeSpan.Zero));
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    [Fact]
    public async Task Reads_the_servers_outgoing_and_included_traffic_with_the_read_token()
    {
        var handler = new StubHandler("""{"server":{"id":42,"outgoing_traffic":3000000000000,"included_traffic":20000000000000}}""");
        await using var services = Services(handler);

        var usage = await services.CreateScope().ServiceProvider.GetRequiredService<IRealtimeUsage>().GetMonthToDateAsync(_ct);

        Assert.Equal(new RealtimeUsage(3 * TB, 0, 20 * TB), usage);
        var request = Assert.Single(handler.Requests);
        Assert.Equal("https://hetzner.test/v1/servers/42", request.Uri);
        Assert.Equal("Bearer read-token", request.Authorization);
    }

    [Fact]
    public async Task No_traffic_counted_yet_is_zero()
    {
        await using var services = Services(new StubHandler("""{"server":{"id":42,"outgoing_traffic":null,"included_traffic":20000000000000}}"""));
        var usage = await services.CreateScope().ServiceProvider.GetRequiredService<IRealtimeUsage>().GetMonthToDateAsync(_ct);
        Assert.Equal(0, usage.TotalEgressBytes);
    }

    [Fact]
    public async Task Failures_surface_as_http_errors_for_the_poller_to_retry()
    {
        await using var services = Services(new StubHandler("{}", HttpStatusCode.Unauthorized));
        var usage = services.CreateScope().ServiceProvider.GetRequiredService<IRealtimeUsage>();
        var error = await Assert.ThrowsAsync<HttpRequestException>(() => usage.GetMonthToDateAsync(_ct));
        Assert.Equal(HttpStatusCode.Unauthorized, error.StatusCode);
    }

    [Fact]
    public async Task Hetzner_takes_over_from_cloudflare_only_when_configured()
    {
        await using var hetzner = Services(new StubHandler("{}"));
        await using var cloudflare = Services(new StubHandler("{}"), configured: false);

        Assert.IsType<HetznerRealtimeUsage>(hetzner.CreateScope().ServiceProvider.GetRequiredService<IRealtimeUsage>());
        Assert.IsType<CloudflareRealtimeUsage>(cloudflare.CreateScope().ServiceProvider.GetRequiredService<IRealtimeUsage>());
    }

    private ServiceProvider Services(StubHandler handler, bool configured = true)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["RealtimeUsage:Hetzner:ApiBaseUrl"] = "https://hetzner.test/v1/",
            ["RealtimeUsage:Hetzner:ServerId"] = configured ? "42" : "",
            ["RealtimeUsage:Hetzner:ApiToken"] = configured ? "read-token" : "",
            ["UsageGuard:DataPath"] = Path.Combine(Path.GetTempPath(), $"cipheroom-usage-{Guid.NewGuid():N}.json"),
        }).Build();
        var services = new ServiceCollection()
            .AddSingleton<IConfiguration>(configuration)
            .AddLogging()
            .AddMetrics()
            .AddApplication()
            .AddInfrastructure()
            .AddSingleton<TimeProvider>(_time)
            .AddSingleton<IHostEnvironment>(new UsageGuardTests.TestEnvironment("Production"));
        services.AddHttpClient<HetznerTrafficClient>().ConfigurePrimaryHttpMessageHandler(() => handler);
        return services.BuildServiceProvider(new ServiceProviderOptions { ValidateScopes = true, ValidateOnBuild = true });
    }

    private sealed record Recorded(string Uri, string? Authorization);

    private sealed class StubHandler(string body, HttpStatusCode status = HttpStatusCode.OK) : HttpMessageHandler
    {
        public List<Recorded> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(new(request.RequestUri!.AbsoluteUri, request.Headers.Authorization?.ToString()));
            return Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }
}
