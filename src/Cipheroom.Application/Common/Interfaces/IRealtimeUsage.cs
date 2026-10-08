namespace Cipheroom.Application.Common.Interfaces;

/// <summary>Cloudflare Realtime egress this calendar month (UTC), account-wide — what the free tier counts.</summary>
public sealed record RealtimeUsage(long SfuEgressBytes, long TurnEgressBytes)
{
    public long TotalEgressBytes => SfuEgressBytes + TurnEgressBytes;
}

/// <summary>Where month-to-date Realtime usage comes from (Cloudflare's analytics API).</summary>
public interface IRealtimeUsage
{
    /// <summary>False without credentials: usage is then only estimated from browser reports (dashboards).</summary>
    bool IsConfigured { get; }

    Task<RealtimeUsage> GetMonthToDateAsync(CancellationToken cancellationToken);
}
