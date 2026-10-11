using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Infrastructure.Rtc.LiveKit;
using Microsoft.Extensions.Options;

namespace Cipheroom.Infrastructure.Rtc;

/// <summary>Which media provider this server runs (<c>Media:Provider</c>, compose maps <c>MEDIA_MODE</c>).</summary>
public sealed class MediaOptions
{
    public const string Section = "Media";

    public MediaProvider Provider { get; set; } = MediaProvider.Cloudflare;
}

/// <summary>LiveKit mode needs the LiveKit server's address and API key (Cloudflare's settings are checked at deploy).</summary>
internal sealed class MediaOptionsValidator(IOptions<LiveKitOptions> liveKit) : IValidateOptions<MediaOptions>
{
    public ValidateOptionsResult Validate(string? name, MediaOptions options) =>
        options.Provider == MediaProvider.LiveKit && !liveKit.Value.IsConfigured
            ? ValidateOptionsResult.Fail("LiveKit mode needs LiveKit:Url, LiveKit:ApiKey and LiveKit:ApiSecret (32+ characters).")
            : ValidateOptionsResult.Success;
}
