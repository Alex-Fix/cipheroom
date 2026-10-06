namespace Cipheroom.Domain.Rooms;

/// <summary>Someone in a room. <see cref="ConnectionId"/> identifies their signaling session and stays server-side.</summary>
public sealed record Participant(ParticipantId Id, RoomId RoomId, string ConnectionId, DisplayName DisplayName);
