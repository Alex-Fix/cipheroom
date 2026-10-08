using System.Diagnostics.CodeAnalysis;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Application.UnitTests.Common;

/// <summary>Single-threaded <see cref="IRoomStore"/> over real <see cref="Room"/>s, so handler tests exercise the domain rules.</summary>
internal sealed class FakeRoomStore : IRoomStore
{
    private readonly Dictionary<string, (RoomId Room, ParticipantId Id)> _byConnection = [];
    private readonly Dictionary<RoomId, Room> _rooms = [];

    /// <summary>Joins and (optionally) attaches a media session, like a client that already published.</summary>
    public Participant Join(string connectionId, string roomId = "room-1", string? sfuSessionId = null)
    {
        Assert.True(TryJoin(new RoomId(roomId), connectionId, new DisplayName(connectionId), TestIdentity.Keys, out var self, out _));
        return sfuSessionId is null ? self : InRoom(connectionId, (room, p) => room.AttachSfuSession(p.Id, sfuSessionId))!;
    }

    public Room RoomOf(string connectionId) => _rooms[_byConnection[connectionId].Room];

    public bool TryJoin(
        RoomId roomId,
        string connectionId,
        DisplayName displayName,
        IdentityKeys identity,
        [NotNullWhen(true)] out Participant? self,
        [NotNullWhen(true)] out IReadOnlyList<Participant>? others)
    {
        if (!_rooms.TryGetValue(roomId, out var room))
            _rooms[roomId] = room = new Room(roomId);

        others = [.. room.Participants];
        self = room.Join(connectionId, displayName, identity);
        _byConnection[connectionId] = (roomId, self.Id);
        return true;
    }

    public Participant? FindByConnection(string connectionId) => InRoom(connectionId, (_, self) => self);

    public RoomStoreStats Stats() => new(_rooms.Values.Count(r => !r.IsEmpty), _byConnection.Count);

    public Participant? Leave(string connectionId) =>
        _byConnection.Remove(connectionId, out var known) ? _rooms[known.Room].Leave(connectionId) : null;

    public T? InRoom<T>(string connectionId, Func<Room, Participant, T> action)
        where T : class
    {
        if (!_byConnection.TryGetValue(connectionId, out var known))
            return null;

        var room = _rooms[known.Room];
        return action(room, room.Find(known.Id)!);
    }
}
