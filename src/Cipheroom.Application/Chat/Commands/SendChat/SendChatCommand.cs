using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Common.Telemetry;
using Cipheroom.Application.Media;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Chat.Commands.SendChat;

/// <summary>
/// Relays one chat event to everyone else in the caller's room. The blob is opaque — signed and encrypted end to end
/// with the sender's chat key: the server checks its shape only, never stores or logs it.
/// </summary>
public sealed record SendChatCommand(string ConnectionId, string? Blob) : ICommand<SendChatResult>;

/// <param name="RoomId">The room whose members get it (the hub's group).</param>
public sealed record SendChatResult(ParticipantId FromId, RoomId RoomId);

public sealed class SendChatCommandValidator : AbstractValidator<SendChatCommand>
{
    public SendChatCommandValidator()
    {
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.Blob).Must(ChatRules.IsBlob).WithMessage(ChatRules.InvalidMessage);
    }
}

public sealed class SendChatCommandHandler(IRoomStore rooms, CipheroomMetrics metrics) : ICommandHandler<SendChatCommand, SendChatResult>
{
    public ValueTask<SendChatResult> Handle(SendChatCommand command, CancellationToken cancellationToken)
    {
        // Lobby guests get "Not admitted." from the store: chat is for members only.
        var result = rooms.InRoom(command.ConnectionId, (room, self) => new SendChatResult(self.Id, room.Id))
            ?? throw new NotFoundException(MediaRules.NotInRoom);

        metrics.ChatRelayed();
        return ValueTask.FromResult(result);
    }
}
