namespace Cipheroom.Domain.Rooms;

/// <summary>A call room and its participants. Rooms exist while someone is in them.</summary>
public sealed class Room(RoomId id)
{
    private readonly List<Participant> _participants = [];

    public RoomId Id { get; } = id;

    public IReadOnlyList<Participant> Participants => _participants;

    public bool IsEmpty => _participants.Count == 0;

    /// <summary>Adds a participant with a fresh random id. Returns the new participant.</summary>
    public Participant Join(string connectionId, DisplayName displayName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(connectionId);
        if (_participants.Exists(p => p.ConnectionId == connectionId))
            throw new InvalidOperationException("Connection is already in this room.");

        var participant = new Participant(ParticipantId.New(), Id, connectionId, displayName);
        _participants.Add(participant);
        return participant;
    }

    /// <summary>Removes the participant on this connection, if any.</summary>
    public Participant? Leave(string connectionId)
    {
        var index = _participants.FindIndex(p => p.ConnectionId == connectionId);
        if (index < 0)
            return null;

        var participant = _participants[index];
        _participants.RemoveAt(index);
        return participant;
    }
}
