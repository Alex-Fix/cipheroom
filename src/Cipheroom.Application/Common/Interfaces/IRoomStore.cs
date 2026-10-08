using Cipheroom.Domain.Rooms;

namespace Cipheroom.Application.Common.Interfaces;

/// <summary>Counts across all rooms (members only; people waiting in a lobby aren't participants yet).</summary>
public sealed record RoomStoreStats(int Rooms, int Participants);

/// <summary>
/// Live room state. Each connection is in at most one room, either as a member or waiting in its lobby. All actions
/// run atomically on one room; afterwards the store forgets connections the room no longer has (left, denied,
/// removed, call ended) and drops rooms nobody is in. Actions must be quick, must not await and must not keep
/// references to <see cref="Room"/>: return immutable results (records) only.
/// </summary>
public interface IRoomStore
{
    /// <summary>
    /// Runs <paramref name="action"/> on the room (created if needed) for a connection that is in no room yet; it should
    /// put the connection in as a member or lobby guest. Throws <see cref="Domain.Common.DomainException"/>
    /// ("Already in a room.") if the connection already is in one.
    /// </summary>
    T Enter<T>(RoomId roomId, string connectionId, Func<Room, T> action);

    /// <summary>The connection's member state; null if it isn't a member (not joined, or still in a lobby).</summary>
    Participant? FindByConnection(string connectionId);

    /// <summary>How many rooms and participants there are right now (for metrics).</summary>
    RoomStoreStats Stats();

    /// <summary>
    /// Runs <paramref name="action"/> on the connection's room with its current member state. Null if the connection
    /// isn't in a room; throws <see cref="Domain.Common.DomainException"/> ("Not admitted.") if it is waiting in a lobby.
    /// </summary>
    T? InRoom<T>(string connectionId, Func<Room, Participant, T> action)
        where T : class;

    /// <summary>Runs <paramref name="action"/> on the room the connection is in (member or lobby guest); null if none.</summary>
    T? InAnyRoom<T>(string connectionId, Func<Room, T> action)
        where T : class;
}
