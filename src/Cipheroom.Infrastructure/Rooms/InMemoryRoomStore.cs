using System.Diagnostics.CodeAnalysis;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Infrastructure.Rooms;

/// <summary>Single-node room state; nothing survives a restart (by design for now).</summary>
public sealed class InMemoryRoomStore : IRoomStore
{
    private readonly Lock _gate = new();
    // Join-time snapshot per connection: only Id and RoomId are used; current state lives in the Room.
    private readonly Dictionary<string, Participant> _byConnection = [];
    private readonly Dictionary<RoomId, Room> _rooms = [];

    public bool TryJoin(
        RoomId roomId,
        string connectionId,
        DisplayName displayName,
        IdentityKeys identity,
        VideoCodecs videoCodecs,
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
            self = room.Join(connectionId, displayName, identity, videoCodecs);
            _byConnection[connectionId] = self;
            return true;
        }
    }

    public Participant? FindByConnection(string connectionId) => InRoom(connectionId, (_, self) => self);

    public RoomStoreStats Stats()
    {
        lock (_gate)
            return new RoomStoreStats(_rooms.Count, _byConnection.Count);
    }

    public Participant? Leave(string connectionId)
    {
        lock (_gate)
        {
            if (!_byConnection.Remove(connectionId, out var participant))
                return null;

            var room = _rooms[participant.RoomId];
            var left = room.Leave(connectionId) ?? participant;
            if (room.IsEmpty)
                _rooms.Remove(room.Id);

            return left;
        }
    }

    public T? InRoom<T>(string connectionId, Func<Room, Participant, T> action)
        where T : class
    {
        lock (_gate)
        {
            if (!_byConnection.TryGetValue(connectionId, out var known))
                return null;

            var room = _rooms[known.RoomId];
            // The room holds the current state (participants are immutable records replaced on change).
            var self = room.Participants.First(p => p.Id == known.Id);
            return action(room, self);
        }
    }
}
