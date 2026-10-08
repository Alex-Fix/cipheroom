using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Cipheroom.Infrastructure.Usage;

/// <summary>
/// Typed HttpClient for Cloudflare's GraphQL Analytics API: month-to-date Realtime egress. Base address and the
/// read-only analytics token are set once at registration; never log the token.
/// Datasets confirmed in docs/plans/2026-10-07-observability-design.md (step 1): <c>callsUsageAdaptiveGroups</c> (SFU),
/// <c>callsTurnUsageAdaptiveGroups</c> (TURN).
/// </summary>
public sealed class CloudflareAnalyticsClient(HttpClient http)
{
    private const string Query = """
        query($account: String!, $from: Date!, $to: Date!) {
          viewer {
            accounts(filter: { accountTag: $account }) {
              sfu: callsUsageAdaptiveGroups(filter: { date_geq: $from, date_leq: $to }, limit: 1) { sum { egressBytes } }
              turn: callsTurnUsageAdaptiveGroups(filter: { date_geq: $from, date_leq: $to }, limit: 1) { sum { egressBytes } }
            }
          }
        }
        """;

    /// <summary>Egress bytes from <paramref name="from"/> to <paramref name="to"/> (inclusive days, UTC).</summary>
    public async Task<(long Sfu, long Turn)> GetEgressAsync(string accountId, DateOnly from, DateOnly to, CancellationToken cancellationToken)
    {
        var request = new GraphQlRequest(Query, new Dictionary<string, string>
        {
            ["account"] = accountId,
            ["from"] = from.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            ["to"] = to.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        });

        using var response = await http.PostAsJsonAsync(new Uri("graphql", UriKind.Relative), request, AnalyticsJsonContext.Default.GraphQlRequest, cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new CloudflareAnalyticsException((int)response.StatusCode);

        var body = await response.Content.ReadFromJsonAsync(AnalyticsJsonContext.Default.GraphQlResponse, cancellationToken);
        // GraphQL reports errors (bad token scope, unknown account) with HTTP 200.
        if (body?.Errors is { Count: > 0 } || body?.Data?.Viewer?.Accounts is not [var account, ..])
            throw new CloudflareAnalyticsException((int)response.StatusCode);

        return (Sum(account.Sfu), Sum(account.Turn));
    }

    private static long Sum(IReadOnlyList<UsageGroup>? groups) => groups?.Sum(g => g.Sum?.EgressBytes ?? 0) ?? 0;
}

/// <summary>Carries the HTTP status only — never the response body or the token.</summary>
public sealed class CloudflareAnalyticsException(int status) : Exception($"Cloudflare analytics request failed ({status}).")
{
    public int Status { get; } = status;
}

public sealed record GraphQlRequest(string Query, IReadOnlyDictionary<string, string> Variables);

public sealed record GraphQlResponse(GraphQlData? Data, IReadOnlyList<GraphQlError>? Errors);

public sealed record GraphQlError(string? Message);

public sealed record GraphQlData(GraphQlViewer? Viewer);

public sealed record GraphQlViewer(IReadOnlyList<AccountUsage>? Accounts);

public sealed record AccountUsage(IReadOnlyList<UsageGroup>? Sfu, IReadOnlyList<UsageGroup>? Turn);

public sealed record UsageGroup(UsageSum? Sum);

public sealed record UsageSum(long? EgressBytes);

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]
[JsonSerializable(typeof(GraphQlRequest))]
[JsonSerializable(typeof(GraphQlResponse))]
internal sealed partial class AnalyticsJsonContext : JsonSerializerContext;
