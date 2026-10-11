using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Cipheroom.Domain.Rooms;
using Microsoft.Extensions.Options;

namespace Cipheroom.Infrastructure.Rtc.LiveKit;

/// <summary>
/// LiveKit access tokens (HS256 JWTs with a "video" grant, https://docs.livekit.io/home/get-started/authentication/).
/// They never leave the server: the relay attaches them to its own connection.
/// </summary>
public sealed class LiveKitTokens(IOptions<LiveKitOptions> options, TimeProvider time)
{
    /// <summary>Joins <paramref name="room"/> as <paramref name="identity"/>: publish, subscribe and data, nothing else.</summary>
    public string Participant(RoomId room, ParticipantId identity) =>
        Create(identity.Value, new VideoGrant(Room: room.Value, RoomJoin: true, CanPublish: true, CanSubscribe: true, CanPublishData: true), options.Value.TokenTtlSeconds);

    /// <summary>Server API calls on one room (remove a participant, delete the room).</summary>
    public string RoomAdmin(RoomId room) => Create(AdminIdentity, new VideoGrant(Room: room.Value, RoomAdmin: true), AdminTtlSeconds);

    private const string AdminIdentity = "cipheroom-api";
    private const int AdminTtlSeconds = 60;

    private string Create(string identity, VideoGrant grant, int ttlSeconds)
    {
        var o = options.Value;
        var now = time.GetUtcNow().ToUnixTimeSeconds();
        var header = Base64Url(JsonSerializer.SerializeToUtf8Bytes(new JwtHeader("HS256", "JWT"), LiveKitJsonContext.Default.JwtHeader));
        var payload = Base64Url(JsonSerializer.SerializeToUtf8Bytes(
            new JwtPayload(o.ApiKey, identity, now - 10, now + ttlSeconds, grant), LiveKitJsonContext.Default.JwtPayload));
        var signature = Base64Url(HMACSHA256.HashData(Encoding.UTF8.GetBytes(o.ApiSecret), Encoding.ASCII.GetBytes($"{header}.{payload}")));
        return $"{header}.{payload}.{signature}";
    }

    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

public sealed record JwtHeader([property: JsonPropertyName("alg")] string Alg, [property: JsonPropertyName("typ")] string Typ);

public sealed record JwtPayload(
    [property: JsonPropertyName("iss")] string Iss,
    [property: JsonPropertyName("sub")] string Sub,
    [property: JsonPropertyName("nbf")] long Nbf,
    [property: JsonPropertyName("exp")] long Exp,
    [property: JsonPropertyName("video")] VideoGrant Video);

/// <summary>LiveKit's video grant; unset permissions are omitted (false).</summary>
public sealed record VideoGrant(
    string Room,
    bool? RoomJoin = null,
    bool? RoomAdmin = null,
    bool? CanPublish = null,
    bool? CanSubscribe = null,
    bool? CanPublishData = null);
