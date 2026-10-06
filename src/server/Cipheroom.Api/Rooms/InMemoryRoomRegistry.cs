using System.Diagnostics.CodeAnalysis;
using System.Security.Cryptography;
using Cipheroom.Api.Hubs.Contracts;

namespace Cipheroom.Api.Rooms;

public sealed record Participant(string Id, string RoomId, string ConnectionId, string DisplayName)
{
    public ParticipantDto ToDto() => new(Id, DisplayName);
}

public interface IRoomRegistry
{
    bool TryJoin(
        string roomId,
        string connectionId,
        string displayName,
        [NotNullWhen(true)] out Participant? self,
        [NotNullWhen(true)] out IReadOnlyList<Participant>? others);

    Participant? Find(string connectionId);

    Participant? Leave(string connectionId);
}

/// <summary>Single-node room state. Participant ids are random so connection ids never leave the server.</summary>
public sealed class InMemoryRoomRegistry : IRoomRegistry
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, Participant> _byConnection = new();
    private readonly Dictionary<string, List<Participant>> _byRoom = new();

    public bool TryJoin(
        string roomId,
        string connectionId,
        string displayName,
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

            if (!_byRoom.TryGetValue(roomId, out var members))
                _byRoom[roomId] = members = [];

            others = members.ToList();
            self = new Participant(NewParticipantId(), roomId, connectionId, displayName);
            members.Add(self);
            _byConnection[connectionId] = self;
            return true;
        }
    }

    public Participant? Find(string connectionId)
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

            var members = _byRoom[participant.RoomId];
            members.Remove(participant);
            if (members.Count == 0)
                _byRoom.Remove(participant.RoomId);

            return participant;
        }
    }

    private static string NewParticipantId() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8));
}
