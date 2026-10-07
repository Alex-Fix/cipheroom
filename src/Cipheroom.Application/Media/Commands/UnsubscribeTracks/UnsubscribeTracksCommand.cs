using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Media.Commands.UnsubscribeTracks;

/// <summary>
/// Stop receiving tracks by the caller's receiving mids (e.g. after TracksUnpublished / ParticipantLeft). Mids the
/// server already forgot (publisher left) are still closed on the caller's own session, which is all they can reach.
/// </summary>
public sealed record UnsubscribeTracksCommand(string ConnectionId, IReadOnlyList<string?>? Mids) : ICommand;

public sealed class UnsubscribeTracksCommandValidator : AbstractValidator<UnsubscribeTracksCommand>
{
    public UnsubscribeTracksCommandValidator()
    {
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.Mids)
            .Must(m => m is { Count: > 0 and <= MediaRules.MaxTracksPerRequest } && m.All(MediaRules.IsMid) && m.Distinct().Count() == m.Count)
            .WithMessage(MediaRules.InvalidTrack);
    }
}

public sealed class UnsubscribeTracksCommandHandler(IRoomStore rooms, ISfu sfu) : ICommandHandler<UnsubscribeTracksCommand>
{
    public async ValueTask<Unit> Handle(UnsubscribeTracksCommand command, CancellationToken cancellationToken)
    {
        string[] mids = [.. command.Mids!.Select(m => m!)];

        var sessionId = rooms.InRoom(command.ConnectionId, (room, self) =>
            {
                room.Unsubscribe(self.Id, mids);
                return self.SfuSessionId ?? "";
            })
            ?? throw new NotFoundException(MediaRules.NotInRoom);

        if (sessionId.Length > 0)
            await sfu.CloseTracksAsync(sessionId, mids, cancellationToken);
        return Unit.Value;
    }
}
