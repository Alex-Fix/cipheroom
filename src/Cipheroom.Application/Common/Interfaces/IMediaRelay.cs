using Cipheroom.Domain.Rooms;

namespace Cipheroom.Application.Common.Interfaces;

/// <summary>Who a relay belongs to: the browser's SignalR connection, as an admitted member of a room.</summary>
public sealed record MediaRelayOwner(string ConnectionId, RoomId RoomId, ParticipantId ParticipantId);

/// <summary>
/// Carries LiveKit's signaling WebSocket over SignalR (docs/plans/2026-10-11-livekit-media-mode-design.md): the api
/// opens the real socket to the LiveKit server with a token it creates and copies opaque messages both ways. Messages
/// contain SDP and ICE candidates — never parsed, never logged. Failures surface as
/// <see cref="Exceptions.MediaServerException"/>.
/// </summary>
public interface IMediaRelay
{
    /// <summary>Opens relay <paramref name="relayId"/> (chosen by the browser) to LiveKit's <paramref name="path"/>.</summary>
    Task OpenAsync(MediaRelayOwner owner, string relayId, string path, string query, CancellationToken cancellationToken);

    /// <summary>One message upstream. Unknown relays (closed meanwhile) are ignored.</summary>
    Task SendAsync(string connectionId, string relayId, ReadOnlyMemory<byte> message, bool text, CancellationToken cancellationToken);

    Task CloseAsync(string connectionId, string relayId);

    /// <summary>Everything a connection has open (it left, or was removed).</summary>
    Task CloseConnectionAsync(string connectionId);

    /// <summary>Everything in a room (the call ended).</summary>
    Task CloseRoomAsync(RoomId room);
}

/// <summary>Where relayed messages from LiveKit go: the browser's SignalR connection (implemented by the hub layer).</summary>
public interface IMediaRelaySink
{
    Task ReceivedAsync(string connectionId, string relayId, ReadOnlyMemory<byte> message, bool text, CancellationToken cancellationToken);

    /// <summary>LiveKit (or the relay) closed the socket; livekit-client sees a WebSocket close and reconnects.</summary>
    Task ClosedAsync(string connectionId, string relayId, int code);
}
