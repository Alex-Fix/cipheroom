using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Infrastructure.Rtc.LiveKit;

/// <summary>
/// <see cref="IMediaRoom"/> on LiveKit: a removed participant loses their signaling relay and is removed from the
/// LiveKit room (LiveKit stops forwarding at once); an ended call closes every relay and deletes the room.
/// </summary>
public sealed class LiveKitMediaRoom(IMediaRelay relay, LiveKitRoomServiceClient rooms, LiveKitTokens tokens) : IMediaRoom
{
    public MediaProvider Provider => MediaProvider.LiveKit;

    public async Task RemoveParticipantAsync(RoomId room, Participant removed, CancellationToken cancellationToken)
    {
        await relay.CloseConnectionAsync(removed.ConnectionId);
        await rooms.RemoveParticipantAsync(room.Value, removed.Id.Value, tokens.RoomAdmin(room), cancellationToken);
    }

    public async Task EndRoomAsync(RoomId room, CancellationToken cancellationToken)
    {
        await relay.CloseRoomAsync(room);
        await rooms.DeleteRoomAsync(room.Value, tokens.RoomAdmin(room), cancellationToken);
    }
}
