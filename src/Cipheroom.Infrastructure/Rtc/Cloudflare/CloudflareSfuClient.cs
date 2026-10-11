using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using System.Text.RegularExpressions;

namespace Cipheroom.Infrastructure.Rtc.Cloudflare;

/// <summary>
/// Typed HttpClient for the Cloudflare Realtime SFU API (sessions and tracks). Base address
/// (<c>…/apps/{appId}/</c>) and the app-secret bearer token are set once at registration. Cloudflare requires
/// mutations on one session to be ordered; callers serialize them. Never log SDP (it carries client IPs) or the secret.
/// https://developers.cloudflare.com/realtime/sfu/https-api/
/// </summary>
public sealed class CloudflareSfuClient(HttpClient http)
{
    public async Task<NewSessionResponse> NewSessionAsync(CancellationToken cancellationToken) =>
        await SendAsync(HttpMethod.Post, "sessions/new", null, CloudflareJsonContext.Default.NewSessionResponse, cancellationToken);

    public Task<TracksResponse> NewTracksAsync(string sessionId, TracksRequest request, CancellationToken cancellationToken) =>
        SendAsync(HttpMethod.Post, $"sessions/{Escape(sessionId)}/tracks/new",
            JsonContent.Create(request, CloudflareJsonContext.Default.TracksRequest),
            CloudflareJsonContext.Default.TracksResponse, cancellationToken);

    public Task<TracksResponse> UpdateTracksAsync(string sessionId, TracksRequest request, CancellationToken cancellationToken) =>
        SendAsync(HttpMethod.Put, $"sessions/{Escape(sessionId)}/tracks/update",
            JsonContent.Create(request, CloudflareJsonContext.Default.TracksRequest),
            CloudflareJsonContext.Default.TracksResponse, cancellationToken);

    public Task<TracksResponse> CloseTracksAsync(string sessionId, CloseTracksRequest request, CancellationToken cancellationToken) =>
        SendAsync(HttpMethod.Put, $"sessions/{Escape(sessionId)}/tracks/close",
            JsonContent.Create(request, CloudflareJsonContext.Default.CloseTracksRequest),
            CloudflareJsonContext.Default.TracksResponse, cancellationToken);

    public Task<RenegotiateResponse> RenegotiateAsync(string sessionId, RenegotiateRequest request, CancellationToken cancellationToken) =>
        SendAsync(HttpMethod.Put, $"sessions/{Escape(sessionId)}/renegotiate",
            JsonContent.Create(request, CloudflareJsonContext.Default.RenegotiateRequest),
            CloudflareJsonContext.Default.RenegotiateResponse, cancellationToken);

    public Task<EstablishDataTransportResponse> EstablishDataTransportAsync(string sessionId, EstablishDataTransportRequest request, CancellationToken cancellationToken) =>
        SendAsync(HttpMethod.Post, $"sessions/{Escape(sessionId)}/datachannels/establish",
            JsonContent.Create(request, CloudflareJsonContext.Default.EstablishDataTransportRequest),
            CloudflareJsonContext.Default.EstablishDataTransportResponse, cancellationToken);

    public Task<DataChannelsResponse> NewDataChannelsAsync(string sessionId, DataChannelsRequest request, CancellationToken cancellationToken) =>
        SendAsync(HttpMethod.Post, $"sessions/{Escape(sessionId)}/datachannels/new",
            JsonContent.Create(request, CloudflareJsonContext.Default.DataChannelsRequest),
            CloudflareJsonContext.Default.DataChannelsResponse, cancellationToken);

    public Task<DataChannelsResponse> CloseDataChannelsAsync(string sessionId, DataChannelsRequest request, CancellationToken cancellationToken) =>
        SendAsync(HttpMethod.Put, $"sessions/{Escape(sessionId)}/datachannels/close",
            JsonContent.Create(request, CloudflareJsonContext.Default.DataChannelsRequest),
            CloudflareJsonContext.Default.DataChannelsResponse, cancellationToken);

    private async Task<T> SendAsync<T>(HttpMethod method, string path, HttpContent? content, JsonTypeInfo<T> type, CancellationToken cancellationToken)
        where T : ISfuResponse
    {
        using var request = new HttpRequestMessage(method, new Uri(path, UriKind.Relative)) { Content = content };
        using var response = await http.SendAsync(request, cancellationToken);

        // JSON bodies carry errorCode/errorDescription, even on success (request-level errors). Some failures (bad app
        // id, auth) come back as plain text, so only parse JSON.
        var body = response.Content.Headers.ContentType?.MediaType == "application/json"
            ? await ReadAsync(response, type, cancellationToken)
            : default;
        if (!response.IsSuccessStatusCode || body is null || body.ErrorCode is not null)
            throw new CloudflareSfuException((int)response.StatusCode, body?.ErrorCode, body?.ErrorDescription);

        return body;
    }

    private static async Task<T?> ReadAsync<T>(HttpResponseMessage response, JsonTypeInfo<T> type, CancellationToken cancellationToken)
    {
        try
        {
            return await response.Content.ReadFromJsonAsync(type, cancellationToken);
        }
        catch (JsonException) when (!response.IsSuccessStatusCode)
        {
            return default;
        }
    }

    private static string Escape(string sessionId) => Uri.EscapeDataString(sessionId);
}

/// <summary>
/// A failed SFU call. Carries the status, Cloudflare's error code and its error description made safe to log
/// (<see cref="SafeReason"/>) — never request content.
/// </summary>
public sealed partial class CloudflareSfuException(int statusCode, string? errorCode, string? errorDescription = null)
    : Exception($"Cloudflare SFU request failed: HTTP {statusCode} {errorCode}".TrimEnd()
        + (SafeReason(errorDescription) is { } reason ? $" ({reason})" : ""))
{
    public const int MaxReasonLength = 200;

    public int StatusCode { get; } = statusCode;

    public string? ErrorCode { get; } = errorCode;

    /// <summary>
    /// Cloudflare's description with anything that could carry SDP or addresses removed: SDP-looking lines
    /// (<c>a=</c>, <c>m=</c>, <c>c=</c>, <c>o=</c>, …), IPv4 and IPv6 addresses; at most <see cref="MaxReasonLength"/>
    /// characters. Null when nothing is left.
    /// </summary>
    public static string? SafeReason(string? description)
    {
        if (string.IsNullOrWhiteSpace(description))
            return null;
        var lines = description.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)
            .Where(l => !SdpLine().IsMatch(l.Trim()));
        var text = Ipv6().Replace(Ipv4().Replace(string.Join(' ', lines), "[ip]"), "[ip]");
        text = SdpField().Replace(text, "[sdp]").Trim();
        if (text.Length == 0)
            return null;
        return text.Length <= MaxReasonLength ? text : text[..MaxReasonLength] + "…";
    }

    [GeneratedRegex(@"^[a-z]=")]
    private static partial Regex SdpLine();

    // An SDP line quoted inside a sentence ("... a=candidate:1 1 udp ...") up to the next quote or the end.
    [GeneratedRegex(@"\b[acmo]=[^""']*")]
    private static partial Regex SdpField();

    [GeneratedRegex(@"\b\d{1,3}(\.\d{1,3}){3}\b")]
    private static partial Regex Ipv4();

    [GeneratedRegex(@"\b[0-9a-fA-F]{1,4}(:[0-9a-fA-F]{0,4}){2,7}\b")]
    private static partial Regex Ipv6();
}

public interface ISfuResponse
{
    string? ErrorCode { get; }

    string? ErrorDescription { get; }
}

public sealed record SessionDescription(string Type, string Sdp);

public sealed record SimulcastPreference(string PreferredRid, string PriorityOrdering = "asciibetical", string RidNotAvailable = "asciibetical");

/// <summary>Track object used by requests and responses; unused fields stay null and are omitted.</summary>
public sealed record SfuTrack(
    string? Location = null,
    string? Mid = null,
    string? SessionId = null,
    string? TrackName = null,
    SimulcastPreference? Simulcast = null,
    string? ErrorCode = null,
    string? ErrorDescription = null);

public sealed record TracksRequest(IReadOnlyList<SfuTrack> Tracks, SessionDescription? SessionDescription = null);

public sealed record CloseTracksRequest(IReadOnlyList<SfuTrack> Tracks, bool Force, SessionDescription? SessionDescription = null);

public sealed record RenegotiateRequest(SessionDescription SessionDescription);

public sealed record NewSessionResponse(string SessionId, string? ErrorCode = null, string? ErrorDescription = null) : ISfuResponse;

public sealed record TracksResponse(
    SessionDescription? SessionDescription = null,
    bool RequiresImmediateRenegotiation = false,
    IReadOnlyList<SfuTrack>? Tracks = null,
    string? ErrorCode = null,
    string? ErrorDescription = null) : ISfuResponse;

public sealed record RenegotiateResponse(
    SessionDescription? SessionDescription = null,
    string? ErrorCode = null,
    string? ErrorDescription = null) : ISfuResponse;

/// <summary>Data channel object used by requests and responses; unused fields stay null and are omitted.</summary>
public sealed record SfuDataChannel(
    string? Location = null,
    string? SessionId = null,
    string? DataChannelName = null,
    int? Id = null,
    string? ErrorCode = null,
    string? ErrorDescription = null);

public sealed record DataChannelsRequest(IReadOnlyList<SfuDataChannel> DataChannels);

public sealed record DataChannelsResponse(
    IReadOnlyList<SfuDataChannel>? DataChannels = null,
    string? ErrorCode = null,
    string? ErrorDescription = null) : ISfuResponse;

public sealed record EstablishDataTransportRequest(SfuDataChannel DataChannel);

public sealed record EstablishDataTransportResponse(
    SessionDescription? SessionDescription = null,
    bool RequiresImmediateRenegotiation = false,
    SfuDataChannel? DataChannel = null,
    string? ErrorCode = null,
    string? ErrorDescription = null) : ISfuResponse;
