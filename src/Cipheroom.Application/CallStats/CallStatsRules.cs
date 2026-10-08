namespace Cipheroom.Application.CallStats;

/// <summary>
/// Limits for browser call-quality reports. Reports are untrusted input that only feeds graphs: every number must be
/// finite, non-negative and below a cap that real calls never reach, so junk can't distort them much or break anything.
/// </summary>
public static class CallStatsRules
{
    public const string InvalidStats = "Invalid stats.";

    /// <summary>Coarse browser buckets the client computes; anything else is recorded as <see cref="OtherPlatform"/>.</summary>
    public static readonly IReadOnlySet<string> Platforms = new HashSet<string>(StringComparer.Ordinal)
    {
        "ios-safari", "android-chrome", "desktop-chrome", "desktop-safari", "desktop-firefox", OtherPlatform,
    };

    public const string OtherPlatform = "other";

    /// <summary>How media reaches Cloudflare: straight (UDP/TCP) or through TURN.</summary>
    public static readonly IReadOnlySet<string> Paths = new HashSet<string>(StringComparer.Ordinal) { "direct", "relay", UnknownPath };

    public const string UnknownPath = "unknown";

    public const double MaxIntervalSeconds = 120;

    /// <summary>1 Gbit/s for the longest interval.</summary>
    public const double MaxBytes = 125_000_000d * MaxIntervalSeconds;

    public const double MaxPackets = 100_000_000;
    public const double MaxJitterMs = 10_000;
    public const double MaxRttMs = 60_000;
    public const double MaxHeight = 4320;
    public const double MaxFps = 240;
    public const double MaxFrames = 10_000_000;
    public const double MaxEnvelopes = 10_000;

    /// <summary>Summed over everyone we're waiting for (64 participants × the longest interval).</summary>
    public const double MaxSecuringSeconds = 64 * MaxIntervalSeconds;

    public static bool InRange(double value, double max) => double.IsFinite(value) && value >= 0 && value <= max;

    public static bool InRange(double? value, double max) => value is not { } v || InRange(v, max);
}
