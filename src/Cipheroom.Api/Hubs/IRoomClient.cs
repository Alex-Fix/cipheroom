using Cipheroom.Api.Hubs.Contracts;

namespace Cipheroom.Api.Hubs;

/// <summary>Server → client events. Mirrored in web/src/app/core/signaling/signaling.types.ts.</summary>
public interface IRoomClient
{
    Task ParticipantJoined(ParticipantDto participant);

    Task ParticipantLeft(string participantId);

    Task TracksPublished(string participantId, IReadOnlyList<TrackDto> tracks);

    /// <param name="sources">microphone / camera / screen.</param>
    Task TracksUnpublished(string participantId, IReadOnlyList<string> sources);

    Task TrackMuted(string participantId, string source, bool muted);

    /// <summary>A sender-key envelope for this client only; <paramref name="fromId"/> is set by the server.</summary>
    Task KeyEnvelopeReceived(string fromId, string blob);

    /// <summary>An encrypted chat event (message or reaction) from another member; <paramref name="fromId"/> is set by the server.</summary>
    Task ChatReceived(string fromId, string blob);

    // Lobby and host controls.

    /// <summary>To an admitter: someone in the lobby asks to join; <paramref name="blob"/> is their name, encrypted to us.</summary>
    Task KnockReceived(LobbyGuestDto guest, string blob);

    /// <summary>To admitters: this guest stopped waiting (admitted, denied, or left).</summary>
    Task LobbyLeft(string guestId);

    /// <summary>To a lobby guest: we're in the call.</summary>
    Task Admitted(LobbyResult result);

    /// <summary>To a lobby guest: turned away.</summary>
    Task Denied();

    /// <summary>To the room and the lobby: the chain of authority or the admitters online changed.</summary>
    Task AuthorityUpdated(AuthorityDto authority);

    /// <summary>To a removed participant: they're out of the call.</summary>
    Task Removed();

    /// <summary>To one participant: an admitter asks them to mute (signed by that admitter's identity).</summary>
    Task MuteRequested(string fromId, long seq, string sig);

    /// <summary>To everyone in the call and the lobby: an admitter ended the call (signed by <paramref name="issuer"/>).</summary>
    Task CallEnded(string issuer, string sig);

    // Usage guard.

    /// <summary>To each connection as it connects, and to everyone when the level changes (server-wide).</summary>
    Task UsageChanged(UsageDto usage);
}
