using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Rooms.Commands.JoinRoom;

/// <summary>Raw client input: validated by <see cref="JoinRoomCommandValidator"/> before the handler runs.</summary>
public sealed record JoinRoomCommand(string ConnectionId, string? RoomId, string? DisplayName) : ICommand<JoinRoomResult>;

/// <param name="Others">Participants who were already in the room.</param>
public sealed record JoinRoomResult(Participant Self, IReadOnlyList<Participant> Others);

public sealed class JoinRoomCommandValidator : AbstractValidator<JoinRoomCommand>
{
    public JoinRoomCommandValidator()
    {
        // Report one problem at a time, room id first (the client shows a single message).
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.RoomId).Must(Domain.Rooms.RoomId.IsValid).WithMessage("Invalid room id.");
        RuleFor(c => c.DisplayName).Must(Domain.Rooms.DisplayName.IsValid).WithMessage("Display name must be 1-64 characters.");
    }
}

public sealed class JoinRoomCommandHandler(IRoomStore rooms) : ICommandHandler<JoinRoomCommand, JoinRoomResult>
{
    public ValueTask<JoinRoomResult> Handle(JoinRoomCommand command, CancellationToken cancellationToken)
    {
        var roomId = new RoomId(command.RoomId!);
        var displayName = new DisplayName(command.DisplayName!);

        if (!rooms.TryJoin(roomId, command.ConnectionId, displayName, out var self, out var others))
            throw new DomainException("Already in a room.");

        return ValueTask.FromResult(new JoinRoomResult(self, others));
    }
}
