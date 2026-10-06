using System.ComponentModel.DataAnnotations;

namespace Cipheroom.Api.Rtc;

public sealed class LiveKitOptions
{
    public const string Section = "LiveKit";

    /// <summary>Browser-facing LiveKit signaling URL, e.g. wss://cipheroom.alexfix.dev/livekit.</summary>
    [Required]
    public string Url { get; set; } = "";

    [Required]
    public string ApiKey { get; set; } = "";

    /// <summary>HS256 signing secret; must be at least 32 bytes.</summary>
    [Required, MinLength(32)]
    public string ApiSecret { get; set; } = "";

    [Range(1, 60)]
    public int TokenTtlMinutes { get; set; } = 10;
}

public sealed class TurnOptions
{
    public const string Section = "Turn";

    public CloudflareTurnOptions Cloudflare { get; set; } = new();

    [Range(300, 86400)]
    public int CredentialTtlSeconds { get; set; } = 14400;
}

public sealed class CloudflareTurnOptions
{
    public string KeyId { get; set; } = "";

    public string ApiToken { get; set; } = "";

    public bool IsConfigured => KeyId.Length > 0 && ApiToken.Length > 0;
}
