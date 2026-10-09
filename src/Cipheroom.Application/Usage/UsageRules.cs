using Cipheroom.Application.Common.Interfaces;

namespace Cipheroom.Application.Usage;

/// <summary>Pure rules of the usage guard: levels from thresholds, the month window, the per-report cap.</summary>
public static class UsageRules
{
    public const string CallsPaused = "Calls are paused.";

    /// <summary>The level for <paramref name="usedBytes"/> of <paramref name="freeTierBytes"/>.</summary>
    public static UsageLevel LevelFor(double usedBytes, long freeTierBytes, int savingPercent, int audioOnlyPercent, int pausedPercent)
    {
        var percent = Percent(usedBytes, freeTierBytes);
        return percent >= pausedPercent ? UsageLevel.Paused
            : percent >= audioOnlyPercent ? UsageLevel.AudioOnly
            : percent >= savingPercent ? UsageLevel.Saving
            : UsageLevel.Normal;
    }

    /// <summary>Percent of the free tier used, rounded down.</summary>
    public static int Percent(double usedBytes, long freeTierBytes) =>
        freeTierBytes <= 0 ? 100 : (int)Math.Min(Math.Floor(usedBytes * 100 / freeTierBytes), 1000);

    /// <summary>"yyyy-MM" of <paramref name="now"/> in UTC: Cloudflare bills by calendar month in UTC.</summary>
    public static string MonthOf(DateTimeOffset now) => now.UtcDateTime.ToString("yyyy-MM", System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>When the free tier resets: the 1st of next month, 00:00 UTC.</summary>
    public static DateTimeOffset ResetsAt(DateTimeOffset now)
    {
        var utc = now.UtcDateTime;
        return new DateTimeOffset(utc.Year, utc.Month, 1, 0, 0, 0, TimeSpan.Zero).AddMonths(1);
    }

    /// <summary>
    /// What one report may add to the estimate: at most <paramref name="maxMbps"/> for its interval (a modified client
    /// can't inflate it beyond what a real call could use), times <paramref name="factor"/> for relay overhead.
    /// </summary>
    public static double Credited(double bytes, double intervalSeconds, double maxMbps, double factor)
    {
        if (!double.IsFinite(bytes) || bytes <= 0 || !double.IsFinite(intervalSeconds) || intervalSeconds <= 0)
            return 0;
        var cap = maxMbps * 1_000_000 / 8 * intervalSeconds;
        return Math.Min(bytes, cap) * factor;
    }
}
