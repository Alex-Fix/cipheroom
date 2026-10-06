using System.Net.Http.Json;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;
using Microsoft.Extensions.Options;

namespace Cipheroom.Infrastructure.Rtc;

/// <summary>Local development: LiveKit is reachable directly, no relay.</summary>
public sealed class DirectIceServerProvider : IIceServerProvider
{
    public Task<IceConfig> GetAsync(ParticipantId participantId, CancellationToken cancellationToken) =>
        Task.FromResult(new IceConfig([], ForceRelay: false));
}

/// <summary>
/// Cloudflare Realtime TURN. LiveKit runs at home without a public IP, so clients must relay.
/// https://developers.cloudflare.com/realtime/turn/generate-credentials/
/// Never log the bearer token or the returned credentials.
/// </summary>
public sealed class CloudflareIceServerProvider(HttpClient http, IOptions<TurnOptions> options) : IIceServerProvider
{
    public async Task<IceConfig> GetAsync(ParticipantId participantId, CancellationToken cancellationToken)
    {
        var opts = options.Value;
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            new Uri($"{Uri.EscapeDataString(opts.Cloudflare.KeyId)}/credentials/generate-ice-servers", UriKind.Relative))
        {
            Content = JsonContent.Create(new { ttl = opts.CredentialTtlSeconds }),
        };
        request.Headers.Authorization = new("Bearer", opts.Cloudflare.ApiToken);

        using var response = await http.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();

        var body = await response.Content.ReadFromJsonAsync<CloudflareIceResponse>(cancellationToken)
            ?? throw new InvalidOperationException("Empty response from Cloudflare TURN.");

        return new IceConfig(body.IceServers, ForceRelay: true);
    }

    private sealed record CloudflareIceResponse(IceServer[] IceServers);
}
