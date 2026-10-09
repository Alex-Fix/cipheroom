using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Common.Telemetry;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Cipheroom.Infrastructure.Usage;

/// <summary>
/// Keeps the free-tier gauges current: month-to-date Realtime egress every <c>PollIntervalMinutes</c>. Failures are
/// logged once per streak (status code only), retried with growing delays (1, 2, 4 … minutes, up to the interval),
/// and the gauges keep their last values. Doesn't run without credentials.
/// </summary>
public sealed partial class RealtimeUsagePoller(
    IServiceScopeFactory scopes,
    CipheroomMetrics metrics,
    UsageGuard guard,
    IOptions<RealtimeUsageOptions> options,
    TimeProvider time,
    ILogger<RealtimeUsagePoller> logger) : BackgroundService
{
    private int _failures;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        metrics.SetRealtimeFreeTier(options.Value.FreeTierGb * 1_000_000_000L);
        if (!options.Value.Cloudflare.IsConfigured)
        {
            LogNotConfigured(logger);
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            await PollAsync(stoppingToken);
            try
            {
                await Task.Delay(NextDelay(), time, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    /// <summary>One poll: updates the gauges, or counts the failure. Never throws (except on shutdown).</summary>
    public async Task PollAsync(CancellationToken cancellationToken)
    {
        try
        {
            // A fresh scope per poll: a singleton must not hold a typed HttpClient (its handler would never rotate).
            await using var scope = scopes.CreateAsyncScope();
            var usage = scope.ServiceProvider.GetRequiredService<IRealtimeUsage>();
            var monthToDate = await usage.GetMonthToDateAsync(cancellationToken);
            var at = time.GetUtcNow();
            metrics.RealtimeUsagePolled(monthToDate, at);
            guard.CloudflarePolled(monthToDate, at);
            _failures = 0;
        }
        catch (Exception ex) when (ex is CloudflareAnalyticsException or HttpRequestException
            || (ex is OperationCanceledException && !cancellationToken.IsCancellationRequested))
        {
            metrics.RealtimeUsagePollFailed();
            if (_failures++ == 0)
                LogFailed(logger, (ex as CloudflareAnalyticsException)?.Status ?? 0);
        }
    }

    internal TimeSpan NextDelay()
    {
        var interval = TimeSpan.FromMinutes(options.Value.PollIntervalMinutes);
        if (_failures == 0)
            return interval;
        var backoff = TimeSpan.FromMinutes(Math.Pow(2, Math.Min(_failures - 1, 10)));
        return backoff < interval ? backoff : interval;
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Realtime usage: no Cloudflare analytics credentials — usage is estimated from browser reports")]
    private static partial void LogNotConfigured(ILogger logger);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Realtime usage: Cloudflare analytics request failed (status {Status}); retrying")]
    private static partial void LogFailed(ILogger logger, int status);
}
