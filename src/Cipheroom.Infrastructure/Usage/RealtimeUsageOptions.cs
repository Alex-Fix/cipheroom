using System.ComponentModel.DataAnnotations;

namespace Cipheroom.Infrastructure.Usage;

public sealed class RealtimeUsageOptions
{
    public const string Section = "RealtimeUsage";

    /// <summary>Free Cloudflare Realtime egress per month (SFU and TURN share it).</summary>
    [Range(1, 100_000)]
    public int FreeTierGb { get; set; } = 1000;

    [Range(1, 1440)]
    public int PollIntervalMinutes { get; set; } = 15;

    public CloudflareAnalyticsOptions Cloudflare { get; set; } = new();
}

public sealed class CloudflareAnalyticsOptions
{
    [Url]
    public string ApiBaseUrl { get; set; } = "https://api.cloudflare.com/client/v4/";

    /// <summary>Account id (the hex id in the dashboard URL).</summary>
    public string AccountId { get; set; } = "";

    /// <summary>API token with only "Account Analytics: Read". Never logged.</summary>
    public string ApiToken { get; set; } = "";

    public bool IsConfigured => AccountId.Length > 0 && ApiToken.Length > 0;
}
