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

    /// <summary>The caller's existing session (renegotiation and closing need one already).</summary>
    public static string Require(IRoomStore rooms, string connectionId)
    {
        var self = Member(rooms, connectionId);
        return self.SfuSessionId ?? throw new DomainException(MediaRules.NoMediaSession);
    }
}
