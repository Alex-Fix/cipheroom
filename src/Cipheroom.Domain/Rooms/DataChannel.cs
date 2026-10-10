namespace Cipheroom.Domain.Rooms;

/// <summary>
/// A media server data channel on a participant's session: one they publish (<see cref="PublisherId"/> null) or one
/// they receive from <see cref="PublisherId"/>. Carries end-to-end encrypted file chunks; the server never sees them.
/// </summary>
/// <param name="Name">The client's random name (22 base64url characters). The media server name is
/// <see cref="SfuNameFor"/>, so nobody can publish under someone else's channel.</param>
/// <param name="Id">The channel id the media server allocated on this participant's session.</param>
public sealed record DataChannel(string Name, int Id, ParticipantId? PublisherId, DateTimeOffset OpenedAt)
{
    public bool IsPublished => PublisherId is null;

    public static string SfuNameFor(ParticipantId owner, string name) => $"{owner.Value}-{name}";
}

/// <summary>Someone else's published data channel, with what the media server needs to forward it.</summary>
public sealed record RemoteDataChannel(ParticipantId PublisherId, string PublisherSfuSessionId, string SfuName);

/// <summary>A data channel the media server must close: channel <paramref name="Id"/> on session <paramref name="SfuSessionId"/>.</summary>
public sealed record DataChannelClosure(string SfuSessionId, int Id);
