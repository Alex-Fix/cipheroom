namespace Cipheroom.Application.Common.Interfaces;

/// <summary>
/// Media egress this period — what the allowance counts: Cloudflare Realtime this calendar month (UTC, account-wide), or
/// a Hetzner server's outgoing traffic this billing period (LiveKit mode). <paramref name="AllowanceBytes"/>: the
/// allowance the source reports itself (Hetzner's included traffic); null = the configured free tier.
/// </summary>
public sealed record RealtimeUsage(long SfuEgressBytes, long TurnEgressBytes, long? AllowanceBytes = null)
{
    public long TotalEgressBytes => SfuEgressBytes + TurnEgressBytes;
}

/// <summary>Where month-to-date usage comes from (Cloudflare's analytics API, or Hetzner's server API).</summary>
public interface IRealtimeUsage
{
    /// <summary>False without credentials: usage is then only estimated from browser reports (dashboards).</summary>
    bool IsConfigured { get; }

    Task<RealtimeUsage> GetMonthToDateAsync(CancellationToken cancellationToken);
}
