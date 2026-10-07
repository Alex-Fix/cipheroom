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

public sealed record ParticipantDto(string Id, string DisplayName, IReadOnlyList<TrackDto> Tracks)
{
    public static ParticipantDto From(Participant p) => new(p.Id.Value, p.DisplayName.Value, [.. p.Tracks.Select(TrackDto.From)]);
}

public sealed record JoinResult(string SelfId, IReadOnlyList<ParticipantDto> Participants);

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
