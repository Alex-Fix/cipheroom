using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Cipheroom.Application.Common.Interfaces;
using Microsoft.Extensions.Options;

namespace Cipheroom.Infrastructure.Usage;

/// <summary>
/// Typed HttpClient for one Hetzner Cloud server (https://docs.hetzner.cloud/#servers-get-a-server): its outgoing
/// traffic and included traffic for the current billing period. Read-only token, set once at registration.
/// </summary>
public sealed class HetznerTrafficClient(HttpClient http)
{
    public async Task<(long Outgoing, long Included)> GetTrafficAsync(string serverId, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync(new Uri($"servers/{Uri.EscapeDataString(serverId)}", UriKind.Relative), cancellationToken);
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync(HetznerJsonContext.Default.HetznerServerResponse, cancellationToken)
            ?? throw new HttpRequestException("Empty Hetzner response.");
        // Hetzner reports null outgoing traffic until it has counted any.
        return (body.Server.OutgoingTraffic ?? 0, body.Server.IncludedTraffic);
    }
}

/// <summary><see cref="IRealtimeUsage"/> from this Hetzner server's traffic: what costs money in LiveKit mode.</summary>
public sealed class HetznerRealtimeUsage(HetznerTrafficClient client, IOptions<RealtimeUsageOptions> options) : IRealtimeUsage
{
    public bool IsConfigured => options.Value.Hetzner.IsConfigured;

    public async Task<RealtimeUsage> GetMonthToDateAsync(CancellationToken cancellationToken)
    {
        var (outgoing, included) = await client.GetTrafficAsync(options.Value.Hetzner.ServerId, cancellationToken);
        return new RealtimeUsage(outgoing, 0, included > 0 ? included : null);
    }
}

public sealed record HetznerServerResponse(HetznerServer Server);

public sealed record HetznerServer(
    [property: JsonPropertyName("outgoing_traffic")] long? OutgoingTraffic,
    [property: JsonPropertyName("included_traffic")] long IncludedTraffic);

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]
[JsonSerializable(typeof(HetznerServerResponse))]
internal sealed partial class HetznerJsonContext : JsonSerializerContext;
