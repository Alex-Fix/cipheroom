using Cipheroom.Domain.Common;

namespace Cipheroom.Domain.Rooms;

/// <summary>
/// A call room, its participants and who publishes / receives which media tracks. Rooms exist while someone is in
/// them. Media rules live here: one track per source, tracks are only visible inside their room.
/// </summary>
public sealed class Room(RoomId id)
{
    public const string UnknownTrack = "Unknown track.";
    public const string InvalidKeyEnvelope = "Invalid key envelope.";

    private readonly List<Participant> _participants = [];

    public RoomId Id { get; } = id;

    public IReadOnlyList<Participant> Participants => _participants;

    public bool IsEmpty => _participants.Count == 0;

    /// <summary>Adds a participant with a fresh random id. Returns the new participant.</summary>
    public Participant Join(string connectionId, DisplayName displayName, IdentityKeys identity)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(connectionId);
        if (_participants.Exists(p => p.ConnectionId == connectionId))
            throw new InvalidOperationException("Connection is already in this room.");

        var participant = new Participant(ParticipantId.New(), Id, connectionId, displayName, identity);
        _participants.Add(participant);
        return participant;
    }

    /// <summary>Removes the participant on this connection, if any, and everyone's subscriptions to their tracks.</summary>
    public Participant? Leave(string connectionId)
    {
        var index = _participants.FindIndex(p => p.ConnectionId == connectionId);
        if (index < 0)
            return null;

        var participant = _participants[index];
        _participants.RemoveAt(index);
        DropSubscriptions(s => s.PublisherId == participant.Id);
        return participant;
    }

    /// <summary>Records the participant's media server session. Keeps an existing one (sessions are never swapped).</summary>
    public Participant AttachSfuSession(ParticipantId id, string sfuSessionId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sfuSessionId);
        var participant = Get(id);
        return participant.SfuSessionId is not null
            ? participant
            : Replace(participant with { SfuSessionId = sfuSessionId });
    }

    /// <summary>Throws if any of <paramref name="sources"/> is already published (or listed twice).</summary>
    public void EnsureCanPublish(ParticipantId id, IReadOnlyCollection<TrackSource> sources)
    {
        var participant = Get(id);
        if (sources.Distinct().Count() != sources.Count || sources.Any(s => participant.Track(s) is not null))
            throw new DomainException("Track already published.");
    }

    /// <summary>Adds the tracks under server-generated names. Requires a media session.</summary>
    public IReadOnlyList<PublishedTrack> Publish(ParticipantId id, IReadOnlyList<(TrackSource Source, string Mid)> tracks)
    {
        EnsureCanPublish(id, [.. tracks.Select(t => t.Source)]);
        var participant = Get(id);
        if (participant.SfuSessionId is null)
            throw new InvalidOperationException("Publishing requires a media session.");

        PublishedTrack[] added = [.. tracks.Select(t => new PublishedTrack(PublishedTrack.NameFor(id, t.Source), t.Source, t.Mid))];
        Replace(participant with { Tracks = [.. participant.Tracks, .. added] });
        return added;
    }

    /// <summary>Removes the participant's tracks for these sources (unknown ones are ignored) and everyone's
    /// subscriptions to them. Returns what was removed.</summary>
    public IReadOnlyList<PublishedTrack> Unpublish(ParticipantId id, IReadOnlyCollection<TrackSource> sources)
    {
        var participant = Get(id);
        PublishedTrack[] removed = [.. participant.Tracks.Where(t => sources.Contains(t.Source))];
        if (removed.Length == 0)
            return [];

        Replace(participant with { Tracks = [.. participant.Tracks.Except(removed)] });
        DropSubscriptions(s => s.PublisherId == id && sources.Contains(s.Source));
        return removed;
    }

    public PublishedTrack SetMuted(ParticipantId id, TrackSource source, bool muted)
    {
        var participant = Get(id);
        var track = participant.Track(source) ?? throw new DomainException(UnknownTrack);
        var updated = track with { Muted = muted };
        Replace(participant with { Tracks = [.. participant.Tracks.Select(t => t == track ? updated : t)] });
        return updated;
    }

    /// <summary>
    /// Resolves tracks a participant wants to receive. Every one must be published by someone else in this room,
    /// otherwise <see cref="UnknownTrack"/>. Tracks the subscriber already receives are skipped.
    /// </summary>
    public IReadOnlyList<RemoteTrack> ResolveForSubscribe(ParticipantId subscriberId, IReadOnlyList<(ParticipantId PublisherId, TrackSource Source)> wanted)
    {
        var subscriber = Get(subscriberId);
        var resolved = new List<RemoteTrack>();
        foreach (var (publisherId, source) in wanted.Distinct())
        {
            var publisher = publisherId == subscriberId ? null : Find(publisherId);
            var track = publisher?.Track(source);
            if (publisher?.SfuSessionId is null || track is null)
                throw new DomainException(UnknownTrack);

            if (!subscriber.Subscriptions.Any(s => s.PublisherId == publisherId && s.Source == source))
                resolved.Add(new RemoteTrack(publisher.Id, publisher.SfuSessionId, track));
        }

        return resolved;
    }

    /// <summary>Records new subscriptions; ones whose track went away in the meantime are skipped.</summary>
    public void Subscribe(ParticipantId subscriberId, IReadOnlyList<Subscription> subscriptions)
    {
        var subscriber = Get(subscriberId);
        Subscription[] live = [.. subscriptions.Where(s => Find(s.PublisherId)?.Track(s.Source) is not null)];
        Replace(subscriber with { Subscriptions = [.. subscriber.Subscriptions, .. live] });
    }

    /// <summary>Removes subscriptions by receiving mid (unknown mids are ignored). Returns what was removed.</summary>
    public IReadOnlyList<Subscription> Unsubscribe(ParticipantId subscriberId, IReadOnlyCollection<string> mids)
    {
        var subscriber = Get(subscriberId);
        Subscription[] removed = [.. subscriber.Subscriptions.Where(s => mids.Contains(s.Mid))];
        if (removed.Length > 0)
            Replace(subscriber with { Subscriptions = [.. subscriber.Subscriptions.Except(removed)] });
        return removed;
    }

    /// <summary>The track a participant receives under <paramref name="mid"/>, with its publisher's session.</summary>
    public RemoteTrack FindSubscription(ParticipantId subscriberId, string mid)
    {
        var subscription = Get(subscriberId).Subscriptions.FirstOrDefault(s => s.Mid == mid);
        var publisher = subscription is null ? null : Find(subscription.PublisherId);
        var track = publisher?.Track(subscription!.Source);
        if (publisher?.SfuSessionId is null || track is null)
            throw new DomainException(UnknownTrack);

        return new RemoteTrack(publisher.Id, publisher.SfuSessionId, track);
    }

    /// <summary>
    /// Who a participant's key envelopes go to: each must be someone else in this room, so envelopes can never be
    /// relayed outside it. Throws <see cref="DomainException"/> otherwise.
    /// </summary>
    public IReadOnlyList<Participant> EnvelopeRecipients(ParticipantId senderId, IReadOnlyCollection<ParticipantId> recipientIds)
    {
        Get(senderId);
        var recipients = recipientIds.Select(id => id == senderId ? null : Find(id)).ToArray();
        if (recipients.Any(r => r is null))
            throw new DomainException(InvalidKeyEnvelope);
        return recipients!;
    }

    public Participant? Find(ParticipantId id) => _participants.Find(p => p.Id == id);

    private Participant Get(ParticipantId id) =>
        Find(id) ?? throw new InvalidOperationException("Participant is not in this room.");

    private Participant Replace(Participant updated)
    {
        _participants[_participants.FindIndex(p => p.Id == updated.Id)] = updated;
        return updated;
    }

    private void DropSubscriptions(Func<Subscription, bool> match)
    {
        for (var i = 0; i < _participants.Count; i++)
        {
            var p = _participants[i];
            if (p.Subscriptions.Any(match))
                _participants[i] = p with { Subscriptions = [.. p.Subscriptions.Where(s => !match(s))] };
        }
    }
}

/// <summary>A track published by someone else, with what the media server needs to forward it.</summary>
public sealed record RemoteTrack(ParticipantId PublisherId, string PublisherSfuSessionId, PublishedTrack Track);
