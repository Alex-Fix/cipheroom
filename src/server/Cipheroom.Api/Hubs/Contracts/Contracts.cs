namespace Cipheroom.Api.Hubs.Contracts;

public sealed record ParticipantDto(string Id, string DisplayName);

public sealed record JoinResult(string SelfId, IReadOnlyList<ParticipantDto> Participants);

/// <summary>Mirrors the browser's RTCIceServer shape.</summary>
public sealed record IceServer(string[] Urls, string? Username = null, string? Credential = null);

public sealed record RtcConfig(string LivekitUrl, string Token, IReadOnlyList<IceServer> IceServers, bool ForceRelay);
