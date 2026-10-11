using System.Text.RegularExpressions;
using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Application.Media;

/// <summary>Input limits and constant client messages shared by the media commands.</summary>
public static partial class MediaRules
{
    public const int MaxSdpLength = 32 * 1024;
    public const int MaxTracksPerPublish = 3;

    /// <summary>The SFU accepts up to 64 tracks per request.</summary>
    public const int MaxTracksPerRequest = 64;

    public const string InvalidSdp = "Invalid session description.";
    public const string InvalidTrack = "Invalid track.";
    public const string InvalidLayer = "Invalid layer.";
    public const string NotInRoom = "Join a room first.";
    public const string NoMediaSession = "No media session.";
    public const string NotInThisMode = "Not available in this media mode.";
    public const string InvalidRelay = "Invalid media relay.";
    public const string TooManyRelays = "Too many media relays.";

    /// <summary>One relayed LiveKit signaling message (raw bytes; base64 on the wire must fit SignalR's 64 KB).</summary>
    public const int MaxRelayMessageBytes = 40 * 1024;

    /// <summary>LiveKit's connect query carries a base64 join request (client info, sometimes an offer).</summary>
    public const int MaxRelayQueryLength = 48 * 1024;

    /// <summary>A live relay and one being replaced while livekit-client reconnects.</summary>
    public const int MaxRelaysPerConnection = 2;

    /// <summary>LiveKit's signaling paths.</summary>
    public static readonly IReadOnlyList<string> RelayPaths = ["/rtc/v1", "/rtc"];

    /// <summary>Relay ids are chosen by the browser (it must register the socket before LiveKit's first message).</summary>
    public static bool IsRelayId(string? id) => id is not null && RelayIdRegex().IsMatch(id);

    public static bool IsRelayPath(string? path) => path is not null && RelayPaths.Contains(path);

    public static bool IsRelayQuery(string? query) => query is { Length: <= MaxRelayQueryLength };

    public static bool IsRelayMessage(string? base64) =>
        base64 is { Length: > 0 and <= (MaxRelayMessageBytes + 2) / 3 * 4 } && Base64RelayRegex().IsMatch(base64);

    public static readonly IReadOnlyList<string> Layers = ["f", "h", "q"];

    public static bool IsSdp(string? sdp) =>
        sdp is { Length: > 0 and <= MaxSdpLength } && sdp.StartsWith("v=0", StringComparison.Ordinal);

    /// <summary>Parses a source the validator has already checked.</summary>
    public static TrackSource Source(string? value) =>
        TrackSources.TryParse(value, out var source) ? source : throw new ArgumentException("Unvalidated track source.", nameof(value));

    /// <summary>Transceiver mids as browsers and the SFU produce them (short tokens, usually digits).</summary>
    public static bool IsMid(string? mid) => mid is not null && MidRegex().IsMatch(mid);

    [GeneratedRegex("^[A-Za-z0-9_-]{1,16}$")]
    private static partial Regex MidRegex();

    [GeneratedRegex("^[0-9a-f]{16}$")]
    private static partial Regex RelayIdRegex();

    [GeneratedRegex("^[A-Za-z0-9+/]*={0,2}$")]
    private static partial Regex Base64RelayRegex();
}

/// <summary>Media sessions are created lazily: on the first publish or subscribe.</summary>
internal static class MediaSessions
{
    /// <summary>The caller as a member of their room: "Join a room first." if in none, "Not admitted." if still waiting in a lobby.</summary>
    public static Participant Member(IRoomStore rooms, string connectionId) =>
        rooms.InRoom(connectionId, (_, self) => self) ?? throw new NotFoundException(MediaRules.NotInRoom);

    public static async Task<Participant> EnsureAsync(IRoomStore rooms, ISfu sfu, string connectionId, CancellationToken cancellationToken)
    {
        var self = Member(rooms, connectionId);
        if (self.SfuSessionId is not null)
            return self;

        var sessionId = await sfu.CreateSessionAsync(cancellationToken);
        return rooms.InRoom(connectionId, (room, p) => room.AttachSfuSession(p.Id, sessionId))
            ?? throw new NotFoundException(MediaRules.NotInRoom);
    }

    /// <summary>Runs <paramref name="action"/> on the caller's room as a member ("Join a room first." if in none).</summary>
    public static T InRoom<T>(IRoomStore rooms, string connectionId, Func<Room, Participant, T> action) =>
        (rooms.InRoom(connectionId, (room, self) => new Box<T>(action(room, self))) ?? throw new NotFoundException(MediaRules.NotInRoom)).Value;

    private sealed record Box<T>(T Value);

    /// <summary>Fails unless this server runs <paramref name="provider"/>.</summary>
    public static void RequireProvider(IMediaRoom media, MediaProvider provider)
    {
        if (media.Provider != provider)
            throw new DomainException(MediaRules.NotInThisMode);
    }

    /// <summary>The caller's existing session (renegotiation and closing need one already).</summary>
    public static string Require(IRoomStore rooms, string connectionId)
    {
        var self = Member(rooms, connectionId);
        return self.SfuSessionId ?? throw new DomainException(MediaRules.NoMediaSession);
    }
}
