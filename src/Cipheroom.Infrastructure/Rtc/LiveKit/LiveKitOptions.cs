using System.ComponentModel.DataAnnotations;

namespace Cipheroom.Infrastructure.Rtc.LiveKit;

public sealed class LiveKitOptions
{
    public const string Section = "LiveKit";

    /// <summary>The LiveKit server on the compose network (signaling and server API; never published).</summary>
    [Url]
    public string Url { get; set; } = "http://livekit:7880";

    public string ApiKey { get; set; } = "";

    /// <summary>Signs access tokens (HMAC). Server-side only: never sent to clients or logged.</summary>
    public string ApiSecret { get; set; } = "";

    /// <summary>A relay's access token only has to outlive the connect; reconnects open a new relay with a new one.</summary>
    [Range(60, 3600)]
    public int TokenTtlSeconds { get; set; } = 600;

    public bool IsConfigured => Uri.IsWellFormedUriString(Url, UriKind.Absolute) && ApiKey.Length > 0 && ApiSecret.Length >= 32;
}
