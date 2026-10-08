using System.Diagnostics.Metrics;
using System.Net;
using System.Text;
using Cipheroom.Application;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Common.Telemetry;
using Cipheroom.Infrastructure.Usage;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.Metrics.Testing;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Time.Testing;

namespace Cipheroom.Infrastructure.IntegrationTests.Usage;

/// <summary>Free-tier usage through the real AddInfrastructure() registration; only the network and the clock are fake.</summary>
public sealed class RealtimeUsageTests
{
    private const string Account = "00cc7275dabd138c1f234622b02afd7c";
    private const string Usage = """
        {"data":{"viewer":{"accounts":[{"sfu":[{"sum":{"egressBytes":180457018}}],"turn":[{"sum":{"egressBytes":19757456}}]}]}},"errors":null}
        """;

    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 10, 7, 22, 30, 0, TimeSpan.Zero));
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    [Fact]
    public async Task Reads_month_to_date_sfu_and_turn_egress_with_the_analytics_token()
    {
        var handler = new StubHandler(HttpStatusCode.OK, Usage);
        var usage = Services(handler).GetRequiredService<IRealtimeUsage>();

        var result = await usage.GetMonthToDateAsync(_ct);

        Assert.Equal(new RealtimeUsage(180_457_018, 19_757_456), result);
        var request = Assert.Single(handler.Requests);
        Assert.Equal("https://api.test/client/v4/graphql", request.Uri);
        Assert.Equal("Bearer analytics-token", request.Authorization);
        Assert.Contains("\"account\":\"" + Account + "\"", request.Body, StringComparison.Ordinal);
        Assert.Contains("\"from\":\"2026-10-01\"", request.Body, StringComparison.Ordinal);
        Assert.Contains("\"to\":\"2026-10-07\"", request.Body, StringComparison.Ordinal);
        Assert.Contains("callsUsageAdaptiveGroups", request.Body, StringComparison.Ordinal);
        Assert.Contains("callsTurnUsageAdaptiveGroups", request.Body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Uses_the_utc_calendar_month_as_cloudflare_bills_it()
    {
        _time.SetUtcNow(new DateTimeOffset(2026, 11, 1, 0, 30, 0, TimeSpan.Zero));
        var handler = new StubHandler(HttpStatusCode.OK, Usage);

        await Services(handler).GetRequiredService<IRealtimeUsage>().GetMonthToDateAsync(_ct);

        Assert.Contains("\"from\":\"2026-11-01\"", handler.Requests[0].Body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task No_usage_yet_is_zero()
    {
        var handler = new StubHandler(HttpStatusCode.OK, """{"data":{"viewer":{"accounts":[{"sfu":[],"turn":[]}]}}}""");
        Assert.Equal(new RealtimeUsage(0, 0), await Services(handler).GetRequiredService<IRealtimeUsage>().GetMonthToDateAsync(_ct));
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden, """{"errors":[{"message":"not authorized"}]}""")]
    [InlineData(HttpStatusCode.OK, """{"data":null,"errors":[{"message":"not authorized for that account"}]}""")]
    [InlineData(HttpStatusCode.OK, """{"data":{"viewer":{"accounts":[]}}}""")]
    public async Task Failures_carry_only_the_status(HttpStatusCode status, string body)
    {
        var usage = Services(new StubHandler(status, body)).GetRequiredService<IRealtimeUsage>();

        var error = await Assert.ThrowsAsync<CloudflareAnalyticsException>(() => usage.GetMonthToDateAsync(_ct));
        Assert.Equal((int)status, error.Status);
        Assert.DoesNotContain("authorized", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_poller_publishes_usage_and_keeps_the_last_values_when_cloudflare_fails()
    {
        var handler = new StubHandler(HttpStatusCode.OK, Usage);
        var services = Services(handler);
        var factory = services.GetRequiredService<IMeterFactory>();
        using var egress = new MetricCollector<long>(factory, CipheroomMetrics.MeterName, "cipheroom.realtime.egress");
        using var polls = new MetricCollector<long>(factory, CipheroomMetrics.MeterName, "cipheroom.realtime.polls");
        var poller = Poller(services);

        await poller.PollAsync(_ct);
        handler.Fail = true;
        await poller.PollAsync(_ct);

        egress.RecordObservableInstruments();
        var latest = egress.GetMeasurementSnapshot().TakeLast(2).ToDictionary(m => (string)m.Tags["service"]!, m => m.Value);
        Assert.Equal(180_457_018, latest["sfu"]);
        Assert.Equal(19_757_456, latest["turn"]);
        Assert.Equal(["ok", "failed"], polls.GetMeasurementSnapshot().Select(m => (string)m.Tags["outcome"]!));
    }

    [Fact]
    public async Task The_poller_backs_off_after_failures_up_to_the_poll_interval()
    {
        // Not a transient status: the resilience handler doesn't retry it (its retry delays would wait on the fake clock).
        var handler = new StubHandler(HttpStatusCode.Forbidden, "{}");
        var poller = Poller(Services(handler));
        Assert.Equal(TimeSpan.FromMinutes(15), poller.NextDelay());

        List<TimeSpan> delays = [];
        for (var i = 0; i < 6; i++)
        {
            await poller.PollAsync(_ct);
            delays.Add(poller.NextDelay());
        }

        Assert.Equal([1, 2, 4, 8, 15, 15], delays.Select(d => d.TotalMinutes));
        handler.Fail = false;
        handler.Body = Usage;
        handler.Status = HttpStatusCode.OK;
        await poller.PollAsync(_ct);
        Assert.Equal(TimeSpan.FromMinutes(15), poller.NextDelay());
    }

    [Fact]
    public async Task Without_credentials_the_poller_only_publishes_the_free_tier()
    {
        var handler = new StubHandler(HttpStatusCode.OK, Usage);
        var services = Services(handler, configured: false);
        using var freeTier = new MetricCollector<long>(
            services.GetRequiredService<IMeterFactory>(), CipheroomMetrics.MeterName, "cipheroom.realtime.free_tier");
        var poller = Poller(services);

        await poller.StartAsync(_ct);
        await poller.ExecuteTask!;

        freeTier.RecordObservableInstruments();
        Assert.Equal(1_000_000_000_000, freeTier.LastMeasurement?.Value);
        Assert.Empty(handler.Requests);
    }

    private static RealtimeUsagePoller Poller(IServiceProvider services) =>
        services.GetServices<IHostedService>().OfType<RealtimeUsagePoller>().Single();

    private ServiceProvider Services(StubHandler handler, bool configured = true)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["RealtimeUsage:Cloudflare:ApiBaseUrl"] = "https://api.test/client/v4/",
            ["RealtimeUsage:Cloudflare:AccountId"] = configured ? Account : "",
            ["RealtimeUsage:Cloudflare:ApiToken"] = configured ? "analytics-token" : "",
        }).Build();

        var services = new ServiceCollection()
            .AddSingleton<IConfiguration>(configuration)
            .AddLogging()
            .AddMetrics()
            .AddApplication()
            .AddInfrastructure()
            .AddSingleton<TimeProvider>(_time);
        services.AddHttpClient<CloudflareAnalyticsClient>().ConfigurePrimaryHttpMessageHandler(() => handler);
        return services.BuildServiceProvider(new ServiceProviderOptions { ValidateScopes = true, ValidateOnBuild = true });
    }

    private sealed record Recorded(string Uri, string? Authorization, string Body);

    private sealed class StubHandler(HttpStatusCode status, string body) : HttpMessageHandler
    {
        public List<Recorded> Requests { get; } = [];
        public bool Fail { get; set; }
        public HttpStatusCode Status { get; set; } = status;
        public string Body { get; set; } = body;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(new Recorded(
                request.RequestUri!.ToString(),
                request.Headers.Authorization?.ToString(),
                await request.Content!.ReadAsStringAsync(cancellationToken)));
            return new HttpResponseMessage(Fail ? HttpStatusCode.Forbidden : Status)
            {
                Content = new StringContent(Body, Encoding.UTF8, "application/json"),
            };
        }
    }
}
