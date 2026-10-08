using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Rooms.Commands.LeaveRoom;

/// <summary>Leave the current room or its lobby. Null if the connection was in neither.</summary>
public sealed record LeaveRoomCommand(string ConnectionId) : ICommand<LeaveRoomResult?>;

/// <param name="Left">Set when a member left the call; <paramref name="LeftLobby"/> when a guest stopped waiting.</param>
/// <param name="Authority">The room's authority afterwards (admitters may have changed).</param>
public sealed record LeaveRoomResult(RoomId RoomId, Participant? Left, LobbyGuest? LeftLobby, RoomAuthority Authority);

public sealed class LeaveRoomCommandValidator : AbstractValidator<LeaveRoomCommand>
{
    public LeaveRoomCommandValidator() => RuleFor(c => c.ConnectionId).NotEmpty();
}

public sealed class LeaveRoomCommandHandler(IRoomStore rooms) : ICommandHandler<LeaveRoomCommand, LeaveRoomResult?>
{
    public ValueTask<LeaveRoomResult?> Handle(LeaveRoomCommand command, CancellationToken cancellationToken) =>
        ValueTask.FromResult(rooms.InAnyRoom(command.ConnectionId, room =>
        {
            var left = room.Leave(command.ConnectionId);
            var leftLobby = left is null ? room.LeaveLobby(command.ConnectionId) : null;
            return new LeaveRoomResult(room.Id, left, leftLobby, room.Authority());
        }));
}
