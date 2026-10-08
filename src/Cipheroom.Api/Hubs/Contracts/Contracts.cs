using Cipheroom.Application.Media.Commands.SubscribeTracks;
using Cipheroom.Application.Rtc.Queries.GetRtcConfig;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Api.Hubs.Contracts;

// SignalR wire contract. Mirrored in web/src/app/core/signaling/signaling.types.ts and docs/signaling-protocol.md.

/// <summary>A published track as other participants see it. Media server track names never leave the server.</summary>
/// <param name="Source">microphone, camera or screen.</param>
/// <param name="Kind">audio or video.</param>
public sealed record TrackDto(string Source, string Kind, bool Muted)
{
    public static TrackDto From(PublishedTrack t) => new(t.Source.ToWire(), t.Kind == TrackKind.Audio ? "audio" : "video", t.Muted);
}

/// <summary>A participant's public E2EE keys for this call (base64url), self-signed by their browser.</summary>
public sealed record IdentityDto(string? Ed25519Pub, string? X25519Pub, string? Sig)
{
    public static IdentityDto From(IdentityKeys k) => new(k.Ed25519Pub, k.X25519Pub, k.Sig);
}

/// <param name="VideoCodecs">Video codecs the participant can decode (vp8, vp9; vp8 always).</param>
/// <param name="Ticket">The signed admission that let them in; null for a host (the host key attests them).</param>
public sealed record ParticipantDto(
    string Id,
    IReadOnlyList<TrackDto> Tracks,
    IdentityDto Identity,
    IReadOnlyList<string> VideoCodecs,
    TicketDto? Ticket)
{
    public static ParticipantDto From(Participant p) =>
        new(p.Id.Value, [.. p.Tracks.Select(TrackDto.From)], IdentityDto.From(p.Identity), p.VideoCodecs.Values, p.Ticket is { } t ? new TicketDto(t.Issuer, t.Sig) : null);
}

/// <summary>A sender-key envelope for one recipient. <c>Blob</c> is opaque to the server (signed, encrypted).</summary>
public sealed record KeyEnvelopeDto(string? ToId, string? Blob);

/// <summary>A knock for one admitter: the guest's name, encrypted to that admitter. Opaque to the server.</summary>
public sealed record KnockDto(string? ToId, string? Blob);

/// <summary>Host's browser only: the host public keys (the room id derives from them) and the host key's signature over the caller's identity.</summary>
public sealed record HostProofDto(string? HostEd25519Pub, string? HostX25519Pub, string? Attestation);

/// <summary>An admission ticket: the admitting identity and its signature over the admitted identity.</summary>
public sealed record TicketDto(string? Issuer, string? Sig);

/// <summary>Someone waiting in the lobby, as an admitter sees them (their name arrives encrypted in the knock).</summary>
public sealed record LobbyGuestDto(string Id, IdentityDto Identity)
{
    public static LobbyGuestDto From(LobbyGuest g) => new(g.Id.Value, IdentityDto.From(g.Identity));
}

/// <param name="SelfId">Our participant id (also while waiting in the lobby).</param>
/// <param name="Admitted">False while waiting in the lobby: then <paramref name="Participants"/> is empty.</param>
/// <param name="Ticket">The ticket that admitted us (kept by the browser to rejoin this call without knocking); null for hosts and while waiting.</param>
public sealed record LobbyResult(string SelfId, bool Admitted, IReadOnlyList<ParticipantDto> Participants, AuthorityDto Authority, TicketDto? Ticket)
{
    public static LobbyResult Member(Participant self, IEnumerable<Participant> others, RoomAuthority authority) =>
        new(self.Id.Value, true, [.. others.Select(ParticipantDto.From)], AuthorityDto.From(authority),
            self.Ticket is { } t ? new TicketDto(t.Issuer, t.Sig) : null);
}

public sealed record HostAttestationDto(string Identity, string Sig);

/// <summary>A signed statement by <c>Issuer</c> about <c>Subject</c> (Ed25519 identities, base64url).</summary>
public sealed record StatementDto(string Subject, string Issuer, string Sig);

public sealed record SettingsDto(string Issuer, long Seq, bool AutoAdmit, string Sig);

/// <summary>A host or co-host in the call right now: where knocks go.</summary>
public sealed record AdmitterDto(string Id, IdentityDto Identity);

/// <summary>
/// The room's chain of authority, from the host keys (which the room id commits to) down: host attestations,
/// co-host grants, removals, settings, and who can admit right now. Public keys and signatures only; every client
/// verifies it itself.
/// </summary>
public sealed record AuthorityDto(
    string? HostEd25519Pub,
    string? HostX25519Pub,
    IReadOnlyList<HostAttestationDto> Hosts,
    IReadOnlyList<StatementDto> CoHosts,
    IReadOnlyList<StatementDto> Revoked,
    SettingsDto? Settings,
    IReadOnlyList<AdmitterDto> Admitters)
{
    public static AuthorityDto From(RoomAuthority a) => new(
        a.Host?.Ed25519Pub,
        a.Host?.X25519Pub,
        [.. a.Hosts.Select(h => new HostAttestationDto(h.Identity, h.Sig))],
        [.. a.CoHosts.Select(From)],
        [.. a.Revoked.Select(From)],
        a.Settings is { } s ? new SettingsDto(s.Issuer, s.Seq, s.AutoAdmit, s.Sig) : null,
        [.. a.Admitters.Select(p => new AdmitterDto(p.Id.Value, IdentityDto.From(p.Identity)))]);

    private static StatementDto From(Statement s) => new(s.Subject, s.Issuer, s.Sig);
}

/// <summary>Mirrors the browser's RTCIceServer shape.</summary>
public sealed record IceServer(string[] Urls, string? Username = null, string? Credential = null);

/// <summary>ICE servers for the peer connection to the SFU; <c>ForceRelay</c> = TURN only (testing).</summary>
public sealed record RtcConfig(IReadOnlyList<IceServer> IceServers, bool ForceRelay)
{
    public static RtcConfig From(RtcConfigResult r) => new(
        [.. r.IceServers.Select(s => new IceServer(s.Urls, s.Username, s.Credential))],
        r.ForceRelay);
}

/// <summary>A local track to publish: the client's transceiver mid and what it carries.</summary>
public sealed record PublishTrackDto(string? Mid, string? Source);

/// <summary>A remote track, by publisher and source.</summary>
public sealed record TrackRefDto(string? ParticipantId, string? Source);

public sealed record AnswerDto(string AnswerSdp);

/// <param name="Mid">Receiving transceiver on the caller's peer connection.</param>
public sealed record SubscribedTrackDto(string ParticipantId, string Source, string Mid);

/// <param name="OfferSdp">SFU offer to answer with Renegotiate; null when nothing new was added.</param>
public sealed record SubscribeResult(string? OfferSdp, IReadOnlyList<SubscribedTrackDto> Tracks)
{
    public static SubscribeResult From(SubscribeTracksResult r) =>
        new(r.OfferSdp, [.. r.Tracks.Select(t => new SubscribedTrackDto(t.PublisherId.Value, t.Source.ToWire(), t.Mid))]);
}

/// <summary>
/// A browser's call-quality summary for the last ~15 s: numbers only (no ids, names, addresses or media). Recorded as
/// metrics, never stored or shown to others.
/// </summary>
/// <param name="Platform">ios-safari / android-chrome / desktop-chrome / desktop-safari / desktop-firefox / other.</param>
/// <param name="Path">direct / relay / unknown.</param>
public sealed record CallStatsDto(
    string? Platform,
    string? Path,
    double IntervalSeconds,
    double? RttMs,
    StreamStatsDto? AudioSent,
    StreamStatsDto? AudioReceived,
    StreamStatsDto? VideoSent,
    StreamStatsDto? VideoReceived,
    E2eeStatsDto? E2ee);

public sealed record StreamStatsDto(
    double Bytes,
    double Packets,
    double PacketsLost,
    double? JitterMs,
    double? FreezeSeconds,
    double? Height,
    double? Fps);

public sealed record E2eeStatsDto(
    double FramesEncrypted,
    double FramesDecrypted,
    double FramesFailed,
    double FramesMissingKey,
    double EnvelopesDropped,
    double SecuringSeconds);
