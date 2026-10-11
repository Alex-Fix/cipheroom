using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Cipheroom.Application.Common.Exceptions;

namespace Cipheroom.Infrastructure.Rtc.LiveKit;

/// <summary>
/// Typed HttpClient for LiveKit's server API (Twirp over JSON, https://docs.livekit.io/reference/server/server-apis/).
/// Base address = the LiveKit server on the compose network; each call carries a room-admin token for that room.
/// </summary>
public sealed class LiveKitRoomServiceClient(HttpClient http)
{
    private const string Service = "twirp/livekit.RoomService/";

    public Task RemoveParticipantAsync(string room, string identity, string adminToken, CancellationToken cancellationToken) =>
        PostAsync("RemoveParticipant", JsonContent.Create(new RoomParticipantRequest(room, identity), LiveKitJsonContext.Default.RoomParticipantRequest), adminToken, cancellationToken);

    public Task DeleteRoomAsync(string room, string adminToken, CancellationToken cancellationToken) =>
        PostAsync("DeleteRoom", JsonContent.Create(new RoomRequest(room), LiveKitJsonContext.Default.RoomRequest), adminToken, cancellationToken);

    private async Task PostAsync(string method, HttpContent content, string adminToken, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(Service + method, UriKind.Relative)) { Content = content };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", adminToken);
        HttpResponseMessage response;
        try
        {
            response = await http.SendAsync(request, cancellationToken);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !cancellationToken.IsCancellationRequested)
        {
            // Unreachable or timed out: callers treat media server failures as best effort.
            throw new MediaServerException(e);
        }

        using var _ = response;
        // Twirp "not_found": the participant already left / the room is already gone — what we wanted anyway.
        if (response.IsSuccessStatusCode || response.StatusCode == HttpStatusCode.NotFound)
            return;
        throw new MediaServerException(new HttpRequestException($"LiveKit {method} failed.", null, response.StatusCode));
    }
}

public sealed record RoomParticipantRequest(string Room, string Identity);

public sealed record RoomRequest(string Room);

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(RoomParticipantRequest))]
[JsonSerializable(typeof(RoomRequest))]
[JsonSerializable(typeof(JwtHeader))]
[JsonSerializable(typeof(JwtPayload))]
internal sealed partial class LiveKitJsonContext : JsonSerializerContext;
