using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Application.UnitTests.Common;

/// <summary>Single-threaded <see cref="IRoomStore"/> over real <see cref="Room"/>s, so handler tests exercise the domain rules.</summary>
internal sealed class FakeRoomStore : IRoomStore
{
    private readonly Dictionary<string, RoomId> _byConnection = [];
    private readonly Dictionary<RoomId, Room> _rooms = [];

    /// <summary>
    /// Joins and (optionally) attaches a media session, like a client that already published. The first one in a room
    /// is its host; later ones are admitted by the host. <paramref name="roomId"/> is a short alias ("room-1").
    /// </summary>
    public Participant Join(string connectionId, string roomId = "room-1", string? sfuSessionId = null)
    {
        var id = TestIdentity.Room(roomId);
        var identity = TestIdentity.Distinct(connectionId);
        var self = Enter(id, connectionId, room =>
        {
            if (room.Admitters.Count == 0)
                return room.JoinAsHost(connectionId, identity, VideoCodecs.Baseline, TestIdentity.Host, TestIdentity.Sig);
            var guest = room.EnterLobby(connectionId, identity, VideoCodecs.Baseline, DateTimeOffset.UnixEpoch);
            return room.Admit(room.Admitters[0].Id, guest.Id, TestIdentity.Sig);
        });
        return sfuSessionId is null ? self : InRoom(connectionId, (room, p) => room.AttachSfuSession(p.Id, sfuSessionId))!;
    }

    public Room RoomOf(string connectionId) => _rooms[_byConnection[connectionId]];

    public T Enter<T>(RoomId roomId, string connectionId, Func<Room, T> action)
    {
        if (_byConnection.ContainsKey(connectionId))
            throw new DomainException("Already in a room.");
        if (!_rooms.TryGetValue(roomId, out var room))
            _rooms[roomId] = room = new Room(roomId);
        try
        {
            var result = action(room);
            if (room.HasConnection(connectionId))
                _byConnection[connectionId] = roomId;
            return result;
        }
        finally
        {
            // Like the real store: a failed entry leaves no empty room behind.
            Reconcile();
        }
    }

    public Participant? FindByConnection(string connectionId) =>
        _byConnection.TryGetValue(connectionId, out var roomId)
            ? _rooms[roomId].Participants.FirstOrDefault(p => p.ConnectionId == connectionId)
            : null;

    public RoomStoreStats Stats() => new(_rooms.Count, _rooms.Values.Sum(r => r.Participants.Count));

    public T? InRoom<T>(string connectionId, Func<Room, Participant, T> action)
        where T : class =>
        InAnyRoom(connectionId, room =>
            action(room, room.Participants.FirstOrDefault(p => p.ConnectionId == connectionId) ?? throw new DomainException(Room.NotAdmitted)));

    public IReadOnlyList<T> AcrossRooms<T>(Func<Room, IEnumerable<T>> action)
    {
        try
        {
            return [.. _rooms.Values.ToArray().SelectMany(action)];
        }
        finally
        {
            Reconcile();
        }
    }

    public T? InAnyRoom<T>(string connectionId, Func<Room, T> action)
        where T : class
    {
        if (!_byConnection.TryGetValue(connectionId, out var roomId))
            return null;
        try
        {
            return action(_rooms[roomId]);
        }
        finally
        {
            Reconcile();
        }
    }

    private void Reconcile()
    {
        foreach (var (connection, roomId) in _byConnection.ToArray())
        {
            if (!_rooms[roomId].HasConnection(connection))
                _byConnection.Remove(connection);
        }
        foreach (var empty in _rooms.Where(r => r.Value.IsEmpty).Select(r => r.Key).ToArray())
            _rooms.Remove(empty);
    }
}
