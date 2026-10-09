using System.ComponentModel.DataAnnotations;
using Cipheroom.Application.Common.Interfaces;

namespace Cipheroom.Infrastructure.Usage;

/// <summary>The usage guard (docs/plans/2026-10-09-usage-guard-design.md); the free tier itself is <see cref="RealtimeUsageOptions.FreeTierGb"/>.</summary>
public sealed class UsageGuardOptions : IValidatableObject
{
    public const string Section = "UsageGuard";

    /// <summary>Off: nothing is ever limited (an escape hatch — the $0 rule is then up to you).</summary>
    public bool Enabled { get; set; } = true;

    [Range(1, 100)]
    public int SavingPercent { get; set; } = 80;

    [Range(1, 100)]
    public int AudioOnlyPercent { get; set; } = 95;

    [Range(1, 100)]
    public int PausedPercent { get; set; } = 99;

    /// <summary>Browser reports don't see TURN relay overhead: their bytes count this much more.</summary>
    [Range(1.0, 3.0)]
    public double EstimateFactor { get; set; } = 1.1;

    /// <summary>The most one participant's report can credit, per second of its interval.</summary>
    [Range(1, 1000)]
    public double MaxReportMbps { get; set; } = 50;

    /// <summary>Cloudflare's figure is used while its last successful poll is at most this old.</summary>
    [Range(1, 1440)]
    public int FreshPollMinutes { get; set; } = 45;

    /// <summary>How far behind Cloudflare's analytics may be: the estimate covers this much before each poll too.</summary>
    [Range(0, 720)]
    public int AnalyticsLagMinutes { get; set; } = 60;

    /// <summary>Where the estimate survives restarts (a Docker volume in the compose stack).</summary>
    [Required]
    public string DataPath { get; set; } = "/data/usage.json";

    /// <summary>Pins the level, for trying the guard out. Honoured only in the Development environment.</summary>
    public UsageLevel? ForceLevel { get; set; }

    public IEnumerable<ValidationResult> Validate(ValidationContext validationContext)
    {
        if (!(SavingPercent < AudioOnlyPercent && AudioOnlyPercent < PausedPercent))
            yield return new ValidationResult("Usage guard thresholds must rise: saving < audio-only < paused.");
    }
}
