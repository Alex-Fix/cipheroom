using Cipheroom.Application.Common.Interfaces;
using Microsoft.Extensions.Options;

namespace Cipheroom.Infrastructure.Usage;

/// <summary><see cref="IRealtimeUsage"/> from Cloudflare's analytics, for the current calendar month in UTC (as billed).</summary>
public sealed class CloudflareRealtimeUsage(
    CloudflareAnalyticsClient client,
    IOptions<RealtimeUsageOptions> options,
    TimeProvider time) : IRealtimeUsage
{
    public bool IsConfigured => options.Value.Cloudflare.IsConfigured;

    public async Task<RealtimeUsage> GetMonthToDateAsync(CancellationToken cancellationToken)
    {
        var today = DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime);
        var monthStart = new DateOnly(today.Year, today.Month, 1);
        var (sfu, turn) = await client.GetEgressAsync(options.Value.Cloudflare.AccountId, monthStart, today, cancellationToken);
        return new RealtimeUsage(sfu, turn);
    }
}
