namespace Cipheroom.Domain.Rooms;

/// <summary>
/// Someone waiting to be let into a room. They get no participant list, media or keys until an admitter signs a
/// ticket for their <see cref="Identity"/>. Their name is never known to the server (it travels encrypted).
/// </summary>
public sealed record LobbyGuest(ParticipantId Id, RoomId RoomId, string ConnectionId, IdentityKeys Identity, VideoCodecs VideoCodecs);
