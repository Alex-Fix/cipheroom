using System.Diagnostics.CodeAnalysis;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Application.Common.Interfaces;

/// <summary>Live room state. Each connection is in at most one room.</summary>
public interface IRoomStore
{
    /// <summary>
    /// Atomically adds the connection to the room. False if the connection is already in a room.
    /// <paramref name="others"/> are the participants who were there before.
    /// </summary>
    bool TryJoin(
        RoomId roomId,
        string connectionId,
        DisplayName displayName,
        [NotNullWhen(true)] out Participant? self,
        [NotNullWhen(true)] out IReadOnlyList<Participant>? others);

    Participant? FindByConnection(string connectionId);

    /// <summary>Removes the connection from its room; empty rooms are dropped. Null if it wasn't in one.</summary>
    Participant? Leave(string connectionId);

    /// <summary>
    /// Runs <paramref name="action"/> atomically on the connection's room with its current participant state, and
    /// returns its result; null if the connection isn't in a room. Use it for reads and <see cref="Room"/> changes.
    /// <paramref name="action"/> must be quick and must not await or keep references to <see cref="Room"/>: return
    /// immutable results (records) only.
    /// </summary>
    T? InRoom<T>(string connectionId, Func<Room, Participant, T> action)
        where T : class;
}
