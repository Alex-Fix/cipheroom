using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Rooms.Commands.LeaveRoom;

/// <summary>Leave the current room. Returns who left, or null if the connection wasn't in a room.</summary>
public sealed record LeaveRoomCommand(string ConnectionId) : ICommand<Participant?>;

public sealed class LeaveRoomCommandValidator : AbstractValidator<LeaveRoomCommand>
{
    public LeaveRoomCommandValidator() => RuleFor(c => c.ConnectionId).NotEmpty();
}

public sealed class LeaveRoomCommandHandler(IRoomStore rooms) : ICommandHandler<LeaveRoomCommand, Participant?>
{
    public ValueTask<Participant?> Handle(LeaveRoomCommand command, CancellationToken cancellationToken) =>
        ValueTask.FromResult(rooms.Leave(command.ConnectionId));
}
