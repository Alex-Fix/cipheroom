namespace Cipheroom.Application.Common.Interfaces;

/// <summary>How close this month's Cloudflare Realtime traffic is to the free tier, and what calls may do.</summary>
public enum UsageLevel
{
    /// <summary>Below the saving threshold: nothing is limited.</summary>
    Normal,

    /// <summary>Received video held at the half simulcast layer; senders cap at 720p.</summary>
    Saving,

    /// <summary>No new calls; calls in progress continue audio-only.</summary>
    AudioOnly,

    /// <summary>Every call ended; nothing starts until the month resets.</summary>
    Paused,
}

/// <param name="Percent">Of the free tier, rounded down; null at <see cref="UsageLevel.Normal"/> (not shown to anyone).</param>
/// <param name="ResetsAt">Start of next month, UTC — when the free tier resets.</param>
public sealed record UsageStatus(UsageLevel Level, int? Percent, DateTimeOffset ResetsAt);

/// <summary>The usage guard's current verdict (docs/plans/2026-10-09-usage-guard-design.md).</summary>
public interface IUsageGuard
{
    UsageStatus Current { get; }

    /// <summary>Raised when the level, or the shown percent, changes. Handlers must be quick and not throw.</summary>
    event Action<UsageStatus>? Changed;
}

/// <summary>Where browsers' call-quality reports feed the usage estimate.</summary>
public interface IUsageLedger
{
    /// <summary>Bytes a participant received over <paramref name="intervalSeconds"/> (capped and weighted inside).</summary>
    void RecordReceived(double bytes, double intervalSeconds);
}
