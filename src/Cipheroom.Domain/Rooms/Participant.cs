namespace Cipheroom.Domain.Rooms;

/// <summary>
/// Someone in a room. <see cref="ConnectionId"/> identifies their signaling session and stays server-side, as does
/// <see cref="SfuSessionId"/> (their media server session). <see cref="Identity"/> holds their public E2EE keys for
/// this call, relayed to everyone in the room, as are the <see cref="VideoCodecs"/> their browser can decode and the
/// <see cref="Ticket"/> that admitted them (null for a host, whose identity the host key attests). Display names are
/// not here: they only travel end-to-end encrypted. Immutable: <see cref="Room"/> replaces it on change.
/// </summary>
public sealed record Participant(ParticipantId Id, RoomId RoomId, string ConnectionId, IdentityKeys Identity)
{
    public ParticipantRole Role { get; init; } = ParticipantRole.Guest;

    public Statement? Ticket { get; init; }

    public VideoCodecs VideoCodecs { get; init; } = VideoCodecs.Baseline;

    public string? SfuSessionId { get; init; }

    public IReadOnlyList<PublishedTrack> Tracks { get; init; } = [];

    public IReadOnlyList<Subscription> Subscriptions { get; init; } = [];

    public bool IsAdmitter => Role is ParticipantRole.Host or ParticipantRole.CoHost;

    public PublishedTrack? Track(TrackSource source) => Tracks.FirstOrDefault(t => t.Source == source);
}
