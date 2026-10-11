using Cipheroom.Domain.Rooms;

namespace Cipheroom.Application.Common.Interfaces;

/// <summary>The media provider this server runs (one per deployment; docs/plans/2026-10-11-livekit-media-mode-design.md).</summary>
public enum MediaProvider
{
    /// <summary>Cloudflare Realtime SFU, negotiated through <see cref="ISfu"/>.</summary>
    Cloudflare,

    /// <summary>A self-hosted LiveKit server: its signaling is relayed over SignalR (<see cref="IMediaRelay"/>).</summary>
    LiveKit,
}

/// <summary>
/// Room-level media control every provider supports: what the server does on its own when someone is removed or the
/// call ends. Failures surface as <see cref="Exceptions.MediaServerException"/>; callers treat both as best effort
/// (removed people get no more keys either way).
/// </summary>
public interface IMediaRoom
{
    MediaProvider Provider { get; }

    /// <summary>Stops forwarding media to and from someone who was removed from the room.</summary>
    Task RemoveParticipantAsync(RoomId room, Participant removed, CancellationToken cancellationToken);

    /// <summary>The call ended for everyone.</summary>
    Task EndRoomAsync(RoomId room, CancellationToken cancellationToken);
}
