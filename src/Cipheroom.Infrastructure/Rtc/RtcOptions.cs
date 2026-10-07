using System.ComponentModel.DataAnnotations;

namespace Cipheroom.Infrastructure.Rtc;

public sealed class TurnOptions
{
    public const string Section = "Turn";

    public CloudflareTurnOptions Cloudflare { get; set; } = new();

    [Range(300, 86400)]
    public int CredentialTtlSeconds { get; set; } = 14400;

    /// <summary>Clients use TURN only (iceTransportPolicy "relay"). Off by default: media goes straight to the SFU's
    /// edge; TURN is the fallback for networks that block it. Turn on to test the relay path.</summary>
    public bool ForceRelay { get; set; }
}

public sealed class CloudflareTurnOptions
{
    /// <summary>Cloudflare Realtime TURN API, ending in a slash (key id is appended).</summary>
    [Url]
    public string ApiBaseUrl { get; set; } = "https://rtc.live.cloudflare.com/v1/turn/keys/";

    public string KeyId { get; set; } = "";

    public string ApiToken { get; set; } = "";

    public bool IsConfigured => KeyId.Length > 0 && ApiToken.Length > 0;
}

public sealed class SfuOptions
{
    public const string Section = "Sfu";

    public CloudflareSfuOptions Cloudflare { get; set; } = new();
}

public sealed class CloudflareSfuOptions
{
    /// <summary>Cloudflare Realtime SFU API, ending in a slash (app id is appended).</summary>
    [Url]
    public string ApiBaseUrl { get; set; } = "https://rtc.live.cloudflare.com/v1/apps/";

    public string AppId { get; set; } = "";

    /// <summary>App secret (Bearer token). Server-side only: never sent to clients or logged.</summary>
    public string AppSecret { get; set; } = "";

    public bool IsConfigured => AppId.Length > 0 && AppSecret.Length > 0;
}
