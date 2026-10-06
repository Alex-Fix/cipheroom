using Cipheroom.Application.Rtc.Queries.GetRtcConfig;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Api.Hubs.Contracts;

// SignalR wire contract. Mirrored in web/src/app/core/signaling/signaling.types.ts and docs/signaling-protocol.md.

public sealed record ParticipantDto(string Id, string DisplayName)
{
    public static ParticipantDto From(Participant p) => new(p.Id.Value, p.DisplayName.Value);
}

public sealed record JoinResult(string SelfId, IReadOnlyList<ParticipantDto> Participants);

/// <summary>Mirrors the browser's RTCIceServer shape.</summary>
public sealed record IceServer(string[] Urls, string? Username = null, string? Credential = null);

public sealed record RtcConfig(string LivekitUrl, string Token, IReadOnlyList<IceServer> IceServers, bool ForceRelay)
{
    public static RtcConfig From(RtcConfigResult r) => new(
        r.LivekitUrl,
        r.Token,
        [.. r.IceServers.Select(s => new IceServer(s.Urls, s.Username, s.Credential))],
        r.ForceRelay);
}
