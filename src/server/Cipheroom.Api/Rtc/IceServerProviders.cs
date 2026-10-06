using Cipheroom.Api.Hubs.Contracts;
using Microsoft.Extensions.Options;

namespace Cipheroom.Api.Rtc;

public sealed record IceConfig(IReadOnlyList<IceServer> IceServers, bool ForceRelay);

public interface IIceServerProvider
{
    Task<IceConfig> GetAsync(string participantId, CancellationToken cancellationToken);
}

/// <summary>Local development: LiveKit is reachable directly, no relay.</summary>
public sealed class DirectIceServerProvider : IIceServerProvider
{
    public Task<IceConfig> GetAsync(string participantId, CancellationToken cancellationToken) =>
        Task.FromResult(new IceConfig([], ForceRelay: false));
}

/// <summary>
/// Cloudflare Realtime TURN. LiveKit runs at home without a public IP, so clients must relay.
/// https://developers.cloudflare.com/realtime/turn/generate-credentials/
/// </summary>
public sealed class CloudflareIceServerProvider(HttpClient http, IOptions<TurnOptions> options) : IIceServerProvider
{
    public async Task<IceConfig> GetAsync(string participantId, CancellationToken cancellationToken)
    {
        var opts = options.Value;
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"{Uri.EscapeDataString(opts.Cloudflare.KeyId)}/credentials/generate-ice-servers")
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

public static class RtcServiceCollectionExtensions
{
    public static IServiceCollection AddRtc(this IServiceCollection services)
    {
        services.AddOptions<LiveKitOptions>().BindConfiguration(LiveKitOptions.Section).ValidateDataAnnotations().ValidateOnStart();
        services.AddOptions<TurnOptions>().BindConfiguration(TurnOptions.Section).ValidateDataAnnotations().ValidateOnStart();

        services.AddSingleton<LiveKitTokenService>();
        services.AddHttpClient<CloudflareIceServerProvider>(c => c.BaseAddress = new("https://rtc.live.cloudflare.com/v1/turn/keys/"))
            .AddStandardResilienceHandler();

        // Resolved per use so configuration (and typed HttpClient lifetimes) are honoured.
        services.AddTransient<IIceServerProvider>(sp =>
            sp.GetRequiredService<IOptions<TurnOptions>>().Value.Cloudflare.IsConfigured
                ? sp.GetRequiredService<CloudflareIceServerProvider>()
                : new DirectIceServerProvider());

        return services;
    }
}
