using Cipheroom.Domain.Rooms;

namespace Cipheroom.Application.Common.Interfaces;

/// <summary>Mirrors the browser's RTCIceServer shape.</summary>
public sealed record IceServer(string[] Urls, string? Username = null, string? Credential = null);

public sealed record IceConfig(IReadOnlyList<IceServer> IceServers, bool ForceRelay);

/// <summary>TURN/STUN servers for one participant (short-lived credentials).</summary>
public interface IIceServerProvider
{
    Task<IceConfig> GetAsync(ParticipantId participantId, CancellationToken cancellationToken);
}

