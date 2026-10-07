using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

namespace Cipheroom.Infrastructure.Rtc.Cloudflare;

/// <summary>
/// Typed HttpClient for the Cloudflare Realtime TURN API. Base address and bearer token are set once at registration
/// (<see cref="DependencyInjection.AddInfrastructure"/>); pooling, DNS refresh and resilience come from
/// IHttpClientFactory. Never log the token or the returned credentials.
/// https://developers.cloudflare.com/realtime/turn/generate-credentials/
/// </summary>
public sealed class CloudflareTurnClient(HttpClient http, IOptions<TurnOptions> options)
{
    public async Task<GenerateIceServersResponse> GenerateIceServersAsync(TimeSpan ttl, CancellationToken cancellationToken)
    {
        var path = new Uri($"{Uri.EscapeDataString(options.Value.Cloudflare.KeyId)}/credentials/generate-ice-servers", UriKind.Relative);

        using var response = await http.PostAsJsonAsync(
            path,
            new GenerateIceServersRequest((int)ttl.TotalSeconds),
            CloudflareJsonContext.Default.GenerateIceServersRequest,
            cancellationToken);
        response.EnsureSuccessStatusCode();

        return await response.Content.ReadFromJsonAsync(CloudflareJsonContext.Default.GenerateIceServersResponse, cancellationToken)
            ?? throw new InvalidOperationException("Empty response from Cloudflare TURN.");
    }
}

public sealed record GenerateIceServersRequest(int Ttl);

public sealed record GenerateIceServersResponse(CloudflareIceServer[] IceServers);

public sealed record CloudflareIceServer(string[] Urls, string? Username, string? Credential);

/// <summary>Source-generated JSON for the Cloudflare Realtime APIs (no reflection; trim/AOT friendly).</summary>
[JsonSourceGenerationOptions(JsonSerializerDefaults.Web, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(GenerateIceServersRequest))]
[JsonSerializable(typeof(GenerateIceServersResponse))]
[JsonSerializable(typeof(NewSessionResponse))]
[JsonSerializable(typeof(TracksRequest))]
[JsonSerializable(typeof(TracksResponse))]
[JsonSerializable(typeof(CloseTracksRequest))]
[JsonSerializable(typeof(RenegotiateRequest))]
[JsonSerializable(typeof(RenegotiateResponse))]
internal sealed partial class CloudflareJsonContext : JsonSerializerContext;
