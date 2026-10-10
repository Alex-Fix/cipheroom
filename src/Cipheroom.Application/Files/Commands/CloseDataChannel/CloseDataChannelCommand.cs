using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Media;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Files.Commands.CloseDataChannel;

/// <summary>
/// Closes one of the caller's data channels: their own (<see cref="ParticipantId"/> null), together with everyone's
/// subscriptions to it, or their subscription to that participant's channel. Unknown channels are ignored.
/// </summary>
public sealed record CloseDataChannelCommand(string ConnectionId, string? Name, string? ParticipantId) : ICommand;

public sealed class CloseDataChannelCommandValidator : AbstractValidator<CloseDataChannelCommand>
{
    public CloseDataChannelCommandValidator()
    {
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c)
            .Must(c => FileRules.IsChannelName(c.Name) && (c.ParticipantId is null || Domain.Rooms.ParticipantId.IsValid(c.ParticipantId)))
            .WithMessage(Room.InvalidDataChannel);
    }
}

public sealed class CloseDataChannelCommandHandler(IRoomStore rooms, ISfu sfu) : ICommandHandler<CloseDataChannelCommand>
{
    public async ValueTask<Unit> Handle(CloseDataChannelCommand command, CancellationToken cancellationToken)
    {
        var publisherId = command.ParticipantId is null ? (ParticipantId?)null : new ParticipantId(command.ParticipantId);
        var closures = MediaSessions.InRoom(rooms, command.ConnectionId, (room, p) => room.CloseDataChannel(p.Id, command.Name!, publisherId));
        await DataChannelClosures.CloseAsync(sfu, closures, cancellationToken);
        return Unit.Value;
    }
}
