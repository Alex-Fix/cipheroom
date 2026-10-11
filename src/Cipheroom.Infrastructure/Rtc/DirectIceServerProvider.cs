using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Infrastructure.Rtc;

/// <summary>Local development without TURN credentials: the SFU's own candidates are enough.</summary>
public sealed class DirectIceServerProvider : IIceServerProvider
{
    public Task<IceConfig> GetAsync(ParticipantId participantId, CancellationToken cancellationToken) =>
        Task.FromResult(new IceConfig([], ForceRelay: false));
}
