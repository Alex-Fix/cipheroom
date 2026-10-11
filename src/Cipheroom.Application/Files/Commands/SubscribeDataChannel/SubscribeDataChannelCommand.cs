using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Common.Telemetry;
using Cipheroom.Application.Files.Commands.PublishDataChannel;
using Cipheroom.Application.Media;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Files.Commands.SubscribeDataChannel;

/// <summary>Receives a data channel someone else in the caller's room published. The server resolves the publisher's
/// media session itself: clients never see session ids.</summary>
public sealed record SubscribeDataChannelCommand(string ConnectionId, string? ParticipantId, string? Name) : ICommand<DataChannelResult>;

public sealed class SubscribeDataChannelCommandValidator : AbstractValidator<SubscribeDataChannelCommand>
{
    public SubscribeDataChannelCommandValidator()
    {
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c)
            .Must(c => ParticipantId.IsValid(c.ParticipantId) && FileRules.IsChannelName(c.Name))
            .WithMessage(Room.InvalidDataChannel);
    }
}

public sealed class SubscribeDataChannelCommandHandler(IRoomStore rooms, ISfu sfu, IUsageGuard usage, TimeProvider time, CipheroomMetrics metrics)
    : ICommandHandler<SubscribeDataChannelCommand, DataChannelResult>
{
    public async ValueTask<DataChannelResult> Handle(SubscribeDataChannelCommand command, CancellationToken cancellationToken)
    {
        FileRules.EnsureAllowed(usage);
        var publisherId = new ParticipantId(command.ParticipantId!);
        var name = command.Name!;
        // Resolve first: a channel outside the caller's room fails before any media server call.
        var (self, remote) = MediaSessions.InRoom(rooms, command.ConnectionId, (room, p) => (p, room.ResolveDataChannel(p.Id, publisherId, name)));

        var id = await sfu.SubscribeDataChannelAsync(self.SfuSessionId!, remote.PublisherSfuSessionId, remote.SfuName, cancellationToken);
        var channel = MediaSessions.InRoom(rooms, command.ConnectionId, (room, p) => room.SubscribeDataChannel(p.Id, publisherId, name, id, time.GetUtcNow()));
        if (channel is null)
        {
            // The publisher closed it (or left) meanwhile.
            await sfu.CloseDataChannelsAsync(self.SfuSessionId!, [id], cancellationToken);
            throw new DomainException(Room.InvalidDataChannel);
        }

        metrics.DataChannels("subscribed");
        return new DataChannelResult(id);
    }
}
