using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Common.Telemetry;
using Mediator;

namespace Cipheroom.Application.Files.Commands.CloseExpiredDataChannels;

/// <summary>Closes every data channel older than <see cref="FileRules.ChannelLifetime"/>, in every room. Run
/// periodically by the api.</summary>
public sealed record CloseExpiredDataChannelsCommand : ICommand<int>;

public sealed class CloseExpiredDataChannelsCommandHandler(IRoomStore rooms, ISfu sfu, TimeProvider time, CipheroomMetrics metrics)
    : ICommandHandler<CloseExpiredDataChannelsCommand, int>
{
    public async ValueTask<int> Handle(CloseExpiredDataChannelsCommand command, CancellationToken cancellationToken)
    {
        var openedBefore = time.GetUtcNow() - FileRules.ChannelLifetime;
        var closures = rooms.AcrossRooms(room => room.CloseDataChannelsOpenedBefore(openedBefore));
        if (closures.Count > 0)
        {
            await DataChannelClosures.CloseAsync(sfu, closures, cancellationToken);
            metrics.DataChannels("expired", closures.Count);
        }

        return closures.Count;
    }
}
