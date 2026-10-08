namespace Cipheroom.Domain.Rooms;

/// <summary>
/// Someone in a room. <see cref="ConnectionId"/> identifies their signaling session and stays server-side, as does
/// <see cref="SfuSessionId"/> (their media server session). <see cref="Identity"/> holds their public E2EE keys for
/// this call, relayed to everyone in the room, as are the <see cref="VideoCodecs"/> their browser can decode.
/// Immutable: <see cref="Room"/> replaces it on change.
/// </summary>
public sealed record Participant(ParticipantId Id, RoomId RoomId, string ConnectionId, DisplayName DisplayName, IdentityKeys Identity)
{
    public VideoCodecs VideoCodecs { get; init; } = VideoCodecs.Baseline;

    public string? SfuSessionId { get; init; }

    public IReadOnlyList<PublishedTrack> Tracks { get; init; } = [];

    public IReadOnlyList<Subscription> Subscriptions { get; init; } = [];

    public PublishedTrack? Track(TrackSource source) => Tracks.FirstOrDefault(t => t.Source == source);
}
