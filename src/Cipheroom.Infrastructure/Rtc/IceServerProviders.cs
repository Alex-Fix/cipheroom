using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;
using Cipheroom.Infrastructure.Rtc.Cloudflare;
using Microsoft.Extensions.Options;

namespace Cipheroom.Infrastructure.Rtc;

/// <summary>Local development without TURN credentials: the SFU's own candidates are enough.</summary>
public sealed class DirectIceServerProvider : IIceServerProvider
{
    public Task<IceConfig> GetAsync(ParticipantId participantId, CancellationToken cancellationToken) =>
        Task.FromResult(new IceConfig([], ForceRelay: false));
}

/// <summary>
/// Cloudflare Realtime STUN/TURN for reaching the SFU: TURN is the fallback for networks that block direct UDP
/// (and can be forced with <see cref="TurnOptions.ForceRelay"/>).
/// Adapter only: HTTP lives in <see cref="CloudflareTurnClient"/>.
/// </summary>
public sealed class CloudflareIceServerProvider(CloudflareTurnClient cloudflare, IOptions<TurnOptions> options) : IIceServerProvider
{
    public async Task<IceConfig> GetAsync(ParticipantId participantId, CancellationToken cancellationToken)
    {
        var ttl = TimeSpan.FromSeconds(options.Value.CredentialTtlSeconds);
        var response = await cloudflare.GenerateIceServersAsync(ttl, cancellationToken);

        return new IceConfig(
            [.. response.IceServers.Select(s => new IceServer(s.Urls, s.Username, s.Credential))],
            ForceRelay: options.Value.ForceRelay);
    }
}
