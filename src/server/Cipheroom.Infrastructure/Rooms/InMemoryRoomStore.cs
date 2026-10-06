using System.Diagnostics.CodeAnalysis;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Infrastructure.Rooms;

/// <summary>Single-node room state; nothing survives a restart (by design for now).</summary>
public sealed class InMemoryRoomStore : IRoomStore
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, Participant> _byConnection = [];
    private readonly Dictionary<RoomId, Room> _rooms = [];

    public bool TryJoin(
        RoomId roomId,
        string connectionId,
        DisplayName displayName,
        [NotNullWhen(true)] out Participant? self,
        [NotNullWhen(true)] out IReadOnlyList<Participant>? others)
    {
        lock (_gate)
        {
            if (_byConnection.ContainsKey(connectionId))
            {
                self = null;
                others = null;
                return false;
            }

            if (!_rooms.TryGetValue(roomId, out var room))
                _rooms[roomId] = room = new Room(roomId);

            others = [.. room.Participants];
            self = room.Join(connectionId, displayName);
            _byConnection[connectionId] = self;
            return true;
        }
    }

    public Participant? FindByConnection(string connectionId)
    {
        lock (_gate)
            return _byConnection.GetValueOrDefault(connectionId);
    }

    public Participant? Leave(string connectionId)
    {
        lock (_gate)
        {
            if (!_byConnection.Remove(connectionId, out var participant))
                return null;

            var room = _rooms[participant.RoomId];
            room.Leave(connectionId);
            if (room.IsEmpty)
                _rooms.Remove(room.Id);

            return participant;
        }
    }
}
