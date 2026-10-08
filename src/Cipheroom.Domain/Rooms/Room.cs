using Cipheroom.Domain.Common;

namespace Cipheroom.Domain.Rooms;

/// <summary>
/// A call room: its members, the lobby of people waiting to be let in, who may admit them (the host key's chain of
/// signed statements), and who publishes / receives which media tracks. Rooms exist while someone is in them or
/// waiting. Media rules live here: one track per source, tracks are only visible inside their room.
/// <para>
/// Admission rules live here too; signatures are checked before a statement reaches the room (Application layer), and
/// again by every client. The server's view of roles only gates what it relays — keys go where clients' own checks say.
/// </para>
/// </summary>
public sealed class Room(RoomId id)
{
    public const string UnknownTrack = "Unknown track.";
    public const string InvalidKeyEnvelope = "Invalid key envelope.";
    public const string NotAllowed = "Not allowed.";
    public const string NotAdmitted = "Not admitted.";
    public const string LobbyFull = "Lobby is full.";
    public const string InvalidHostProof = "Invalid host proof.";
    public const string AskedTooOften = "Already asked, try again later.";
    public const string UnknownParticipant = "Unknown participant.";
    public const string InvalidKnock = "Invalid knock.";

    /// <summary>People waiting at once.</summary>
    public const int MaxLobby = 20;

    /// <summary>Host attestations, co-host grants and removals kept per room (each is a few hundred bytes).</summary>
    public const int MaxAuthorityEntries = 64;

    /// <summary>How long someone who was turned away waits before they can ask again (on that connection).</summary>
    public static readonly TimeSpan DenyCooldown = TimeSpan.FromSeconds(30);

    private readonly List<Participant> _participants = [];
    private readonly List<LobbyGuest> _lobby = [];
    private readonly List<HostAttestation> _hosts = [];
    private readonly List<Statement> _coHosts = [];
    private readonly List<Statement> _revoked = [];
    private readonly Dictionary<string, DateTimeOffset> _deniedUntil = [];

    public RoomId Id { get; } = id;

    public IReadOnlyList<Participant> Participants => _participants;

    public IReadOnlyList<LobbyGuest> Lobby => _lobby;

    public HostKeys? Host { get; private set; }

    public RoomSettings? Settings { get; private set; }

    public bool IsEmpty => _participants.Count == 0 && _lobby.Count == 0;

    /// <summary>Members who can admit, remove and end the call right now.</summary>
    public IReadOnlyList<Participant> Admitters => [.. _participants.Where(p => p.IsAdmitter)];

    public bool HasConnection(string connectionId) =>
        _participants.Exists(p => p.ConnectionId == connectionId) || _lobby.Exists(g => g.ConnectionId == connectionId);

    public RoomAuthority Authority() => new(Host, [.. _hosts], [.. _coHosts], [.. _revoked], Settings, Admitters);

    /// <summary>
    /// The host's browser joins straight in. <paramref name="keys"/> must derive this room's id and
    /// <paramref name="attestation"/> must be the host key's signature over the caller's identity (both checked by
    /// the caller). A later host proof must name the same keys.
    /// </summary>
    public Participant JoinAsHost(string connectionId, IdentityKeys identity, VideoCodecs videoCodecs, HostKeys keys, string attestation)
    {
        if (Host is not null && Host != keys)
            throw new DomainException(InvalidHostProof);
        EnsureNewConnection(connectionId);
        EnsureNotRevoked(identity);
        if (!_hosts.Exists(h => h.Identity == identity.Ed25519Pub))
        {
            EnsureAuthorityRoom();
            _hosts.Add(new HostAttestation(identity.Ed25519Pub, attestation));
        }

        Host = keys;
        return Replace(AddParticipant(connectionId, identity, videoCodecs) with { Role = ParticipantRole.Host });
    }

    /// <summary>
    /// Someone who was admitted earlier in this call (same identity, e.g. after a reconnect) joins straight in.
    /// The ticket's signature is checked by the caller; here its issuer must have been a host or co-host.
    /// </summary>
    public bool CanRejoinWith(IdentityKeys identity, Statement ticket) =>
        ticket.Subject == identity.Ed25519Pub && IsAuthorityIdentity(ticket.Issuer) && !IsRevoked(identity.Ed25519Pub);

    public Participant JoinWithTicket(string connectionId, IdentityKeys identity, VideoCodecs videoCodecs, Statement ticket)
    {
        if (!CanRejoinWith(identity, ticket))
            throw new DomainException(NotAllowed);
        var role = IsCoHostIdentity(identity.Ed25519Pub) ? ParticipantRole.CoHost : ParticipantRole.Guest;
        return Replace(AddParticipant(connectionId, identity, videoCodecs) with { Role = role, Ticket = ticket });
    }

    /// <summary>Waits in the lobby until an admitter lets them in.</summary>
    public LobbyGuest EnterLobby(string connectionId, IdentityKeys identity, VideoCodecs videoCodecs, DateTimeOffset now)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(connectionId);
        EnsureNewConnection(connectionId);
        if (_deniedUntil.TryGetValue(connectionId, out var until))
        {
            if (until > now)
                throw new DomainException(AskedTooOften);
            _deniedUntil.Remove(connectionId);
        }
        EnsureNotRevoked(identity);
        if (_lobby.Count >= MaxLobby)
            throw new DomainException(LobbyFull);

        var guest = new LobbyGuest(ParticipantId.New(), Id, connectionId, identity, videoCodecs);
        _lobby.Add(guest);
        return guest;
    }

    public LobbyGuest? LeaveLobby(string connectionId)
    {
        var index = _lobby.FindIndex(g => g.ConnectionId == connectionId);
        if (index < 0)
            return null;
        var guest = _lobby[index];
        _lobby.RemoveAt(index);
        return guest;
    }

    /// <summary>Admitters a lobby guest's knock (their encrypted name) goes to: each must be an admitter right now.</summary>
    public IReadOnlyList<Participant> KnockRecipients(ParticipantId guestId, IReadOnlyCollection<ParticipantId> admitterIds)
    {
        if (!_lobby.Exists(g => g.Id == guestId))
            throw new DomainException(NotAdmitted);
        var recipients = admitterIds.Select(Find).ToArray();
        if (recipients.Any(r => r is not { IsAdmitter: true }))
            throw new DomainException(InvalidKnock);
        return recipients!;
    }

    /// <summary>
    /// Moves a lobby guest into the call. <paramref name="ticketSig"/> is the admitter's identity signature over the
    /// guest's identity (checked by the caller).
    /// </summary>
    public Participant Admit(ParticipantId admitterId, ParticipantId guestId, string ticketSig)
    {
        var admitter = RequireAdmitter(admitterId);
        var guest = FindGuest(guestId);
        _lobby.Remove(guest);
        var ticket = new Statement(guest.Identity.Ed25519Pub, admitter.Identity.Ed25519Pub, ticketSig);
        return Replace(AddParticipant(guest.ConnectionId, guest.Identity, guest.VideoCodecs, guest.Id) with { Ticket = ticket });
    }

    /// <summary>Turns a lobby guest away; that connection can ask again after <see cref="DenyCooldown"/>.</summary>
    public LobbyGuest Deny(ParticipantId admitterId, ParticipantId guestId, DateTimeOffset now)
    {
        RequireAdmitter(admitterId);
        var guest = FindGuest(guestId);
        _lobby.Remove(guest);
        foreach (var expired in _deniedUntil.Where(d => d.Value <= now).Select(d => d.Key).ToArray())
            _deniedUntil.Remove(expired);
        _deniedUntil[guest.ConnectionId] = now + DenyCooldown;
        return guest;
    }

    /// <summary>The host makes a guest a co-host (<paramref name="sig"/>: the host identity's grant, checked by the caller).</summary>
    public Participant GrantCoHost(ParticipantId hostId, ParticipantId targetId, string sig)
    {
        var host = Get(hostId);
        var target = Find(targetId) ?? throw new DomainException(UnknownParticipant);
        if (host.Role != ParticipantRole.Host || target.Role != ParticipantRole.Guest)
            throw new DomainException(NotAllowed);
        EnsureAuthorityRoom();
        _coHosts.Add(new Statement(target.Identity.Ed25519Pub, host.Identity.Ed25519Pub, sig));
        return Replace(target with { Role = ParticipantRole.CoHost });
    }

    /// <summary>
    /// Removes someone from the call for good (their identity is revoked). Hosts can remove anyone else; co-hosts only
    /// guests. Everyone's subscriptions to their tracks go too.
    /// </summary>
    public Participant Remove(ParticipantId actorId, ParticipantId targetId, string sig)
    {
        var actor = RequireAdmitter(actorId);
        var target = Find(targetId) ?? throw new DomainException(UnknownParticipant);
        if (target.Id == actor.Id || (actor.Role == ParticipantRole.CoHost && target.Role != ParticipantRole.Guest))
            throw new DomainException(NotAllowed);
        EnsureAuthorityRoom();
        _revoked.Add(new Statement(target.Identity.Ed25519Pub, actor.Identity.Ed25519Pub, sig));
        return Leave(target.ConnectionId)!;
    }

    /// <summary>The host changes room settings; <paramref name="seq"/> must be newer than the current one.</summary>
    public RoomSettings UpdateSettings(ParticipantId hostId, uint seq, bool autoAdmit, string sig)
    {
        var host = Get(hostId);
        if (host.Role != ParticipantRole.Host || (Settings is not null && seq <= Settings.Seq))
            throw new DomainException(NotAllowed);
        return Settings = new RoomSettings(host.Identity.Ed25519Pub, seq, autoAdmit, sig);
    }

    /// <summary>An admitter asks another member to mute (advisory — the member's browser decides).</summary>
    public Participant MuteTarget(ParticipantId actorId, ParticipantId targetId)
    {
        RequireAdmitter(actorId);
        var target = Find(targetId) ?? throw new DomainException(UnknownParticipant);
        return target.Id == actorId ? throw new DomainException(NotAllowed) : target;
    }

    /// <summary>Ends the call for everyone: members and lobby leave. Returns everyone's connection.</summary>
    public IReadOnlyList<string> End(ParticipantId actorId)
    {
        RequireAdmitter(actorId);
        string[] connections = [.. _participants.Select(p => p.ConnectionId), .. _lobby.Select(g => g.ConnectionId)];
        _participants.Clear();
        _lobby.Clear();
        return connections;
    }

    public Participant RequireAdmitter(ParticipantId id)
    {
        var participant = Get(id);
        return participant.IsAdmitter ? participant : throw new DomainException(NotAllowed);
    }

    /// <summary>Whether <paramref name="identity"/> (Ed25519, base64url) was ever a host or co-host in this room.</summary>
    public bool IsAuthorityIdentity(string identity) => _hosts.Exists(h => h.Identity == identity) || IsCoHostIdentity(identity);

    public bool IsRevoked(string identity) => _revoked.Exists(r => r.Subject == identity);

    private bool IsCoHostIdentity(string identity) => _coHosts.Exists(c => c.Subject == identity);

    private void EnsureNotRevoked(IdentityKeys identity)
    {
        if (IsRevoked(identity.Ed25519Pub))
            throw new DomainException(NotAllowed);
    }

    private void EnsureAuthorityRoom()
    {
        if (_hosts.Count + _coHosts.Count + _revoked.Count >= MaxAuthorityEntries)
            throw new DomainException(NotAllowed);
    }

    private void EnsureNewConnection(string connectionId)
    {
        if (HasConnection(connectionId))
            throw new InvalidOperationException("Connection is already in this room.");
    }

    private LobbyGuest FindGuest(ParticipantId guestId) =>
        _lobby.Find(g => g.Id == guestId) ?? throw new DomainException(UnknownParticipant);

    private Participant AddParticipant(string connectionId, IdentityKeys identity, VideoCodecs videoCodecs, ParticipantId? id = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(connectionId);
        EnsureNewConnection(connectionId);
        var participant = new Participant(id ?? ParticipantId.New(), Id, connectionId, identity) { VideoCodecs = videoCodecs };
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
