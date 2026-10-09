using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Infrastructure.Rooms;

/// <summary>Single-node room state; nothing survives a restart (by design for now).</summary>
public sealed class InMemoryRoomStore : IRoomStore
{
    public const string AlreadyInRoom = "Already in a room.";

    private readonly Lock _gate = new();
    private readonly Dictionary<string, RoomId> _byConnection = [];
    private readonly Dictionary<RoomId, (Room Room, HashSet<string> Connections)> _rooms = [];

    public T Enter<T>(RoomId roomId, string connectionId, Func<Room, T> action)
    {
        lock (_gate)
        {
            if (_byConnection.ContainsKey(connectionId))
                throw new DomainException(AlreadyInRoom);

            if (!_rooms.TryGetValue(roomId, out var entry))
                _rooms[roomId] = entry = (new Room(roomId), []);
            try
            {
                var result = action(entry.Room);
                if (entry.Room.HasConnection(connectionId))
                {
                    entry.Connections.Add(connectionId);
                    _byConnection[connectionId] = roomId;
                }
                return result;
            }
            finally
            {
                Reconcile(entry.Room, entry.Connections);
            }
        }
    }

    public Participant? FindByConnection(string connectionId)
    {
        lock (_gate)
            return _byConnection.TryGetValue(connectionId, out var roomId)
                ? _rooms[roomId].Room.Participants.FirstOrDefault(p => p.ConnectionId == connectionId)
                : null;
    }

    public RoomStoreStats Stats()
    {
        lock (_gate)
            return new RoomStoreStats(_rooms.Count, _rooms.Values.Sum(r => r.Room.Participants.Count));
    }

    public T? InRoom<T>(string connectionId, Func<Room, Participant, T> action)
        where T : class =>
        InAnyRoom(connectionId, room =>
        {
            // The room holds the current state (participants are immutable records replaced on change).
            var self = room.Participants.FirstOrDefault(p => p.ConnectionId == connectionId)
                ?? throw new DomainException(Room.NotAdmitted);
            return action(room, self);
        });

    public T? InAnyRoom<T>(string connectionId, Func<Room, T> action)
        where T : class
    {
        lock (_gate)
        {
            if (!_byConnection.TryGetValue(connectionId, out var roomId))
                return null;

            var (room, connections) = _rooms[roomId];
            try
            {
                return action(room);
            }
            finally
            {
                Reconcile(room, connections);
            }
        }
    }

    public IReadOnlyList<T> AcrossRooms<T>(Func<Room, IEnumerable<T>> action)
    {
        lock (_gate)
        {
            var results = new List<T>();
            foreach (var (room, connections) in _rooms.Values.ToArray())
            {
                try
                {
                    results.AddRange(action(room));
                }
                finally
                {
                    Reconcile(room, connections);
                }
            }
            return results;
        }
    }

    /// <summary>Forgets connections the room no longer has, and the room once nobody is left.</summary>
    private void Reconcile(Room room, HashSet<string> connections)
    {
        connections.RemoveWhere(c =>
        {
            if (room.HasConnection(c))
                return false;
            _byConnection.Remove(c);
            return true;
        });
        if (room.IsEmpty)
            _rooms.Remove(room.Id);
    }
}
