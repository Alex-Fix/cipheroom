using System.ComponentModel.DataAnnotations;
using System.Threading.RateLimiting;
using Cipheroom.Application.Common.Telemetry;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;

namespace Cipheroom.Api.Hubs.Filters;

public sealed class HubRateLimitOptions
{
    public const string Section = "RateLimiting:Hub";

    /// <summary>Burst size: calls allowed back to back.</summary>
    [Range(1, 1000)]
    public int TokenLimit { get; set; } = 20;

    /// <summary>Sustained rate: calls added back per second.</summary>
    [Range(1, 1000)]
    public int TokensPerSecond { get; set; } = 5;
}

/// <summary>
/// Per-connection token bucket for hub method calls. ASP.NET's rate-limiting middleware only sees the WebSocket
/// upgrade, not individual invocations, so this runs as a hub filter. Idle partitions are cleaned up automatically.
/// </summary>
public sealed partial class HubRateLimitFilter : IHubFilter, IDisposable
{
    public const string TooManyRequests = "Too many requests.";

    private readonly PartitionedRateLimiter<string> _limiter;
    private readonly ILogger<HubRateLimitFilter> _logger;
    private readonly CipheroomMetrics _metrics;

    public HubRateLimitFilter(IOptions<HubRateLimitOptions> options, CipheroomMetrics metrics, ILogger<HubRateLimitFilter> logger)
    {
        var opts = options.Value;
        _logger = logger;
        _metrics = metrics;
        _limiter = PartitionedRateLimiter.Create<string, string>(connectionId =>
            RateLimitPartition.GetTokenBucketLimiter(connectionId, _ => new TokenBucketRateLimiterOptions
            {
                TokenLimit = opts.TokenLimit,
                TokensPerPeriod = opts.TokensPerSecond,
                ReplenishmentPeriod = TimeSpan.FromSeconds(1),
                QueueLimit = 0,
                AutoReplenishment = true,
            }));
    }

    public async ValueTask<object?> InvokeMethodAsync(
        HubInvocationContext invocationContext,
        Func<HubInvocationContext, ValueTask<object?>> next)
    {
        using var lease = _limiter.AttemptAcquire(invocationContext.Context.ConnectionId);
        if (!lease.IsAcquired)
        {
            LogLimited(_logger, invocationContext.HubMethodName);
            _metrics.RateLimited(invocationContext.HubMethodName);
            throw new HubException(TooManyRequests);
        }

        return await next(invocationContext);
    }

    public void Dispose() => _limiter.Dispose();

    [LoggerMessage(Level = LogLevel.Warning, Message = "Rate limit hit for {HubMethod}")]
    private static partial void LogLimited(ILogger logger, string hubMethod);
}
