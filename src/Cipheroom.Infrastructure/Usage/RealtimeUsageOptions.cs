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

    /// <summary>LiveKit mode on a Hetzner server: its own traffic counts instead (takes precedence when configured).</summary>
    public HetznerTrafficOptions Hetzner { get; set; } = new();
}

public sealed class HetznerTrafficOptions
{
    [Url]
    public string ApiBaseUrl { get; set; } = "https://api.hetzner.cloud/v1/";

    /// <summary>This server's id (Terraform output).</summary>
    public string ServerId { get; set; } = "";

    /// <summary>A read-only project API token. Never logged.</summary>
    public string ApiToken { get; set; } = "";

    public bool IsConfigured => ServerId.Length > 0 && ServerId.All(char.IsAsciiDigit) && ApiToken.Length > 0;
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
