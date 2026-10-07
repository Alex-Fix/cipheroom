using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Media.Commands.SetTrackMuted;

/// <summary>Mute state of one of the caller's tracks. The media keeps flowing (disabled track); this is for display.</summary>
public sealed record SetTrackMutedCommand(string ConnectionId, string? Source, bool Muted) : ICommand<SetTrackMutedResult>;

public sealed record SetTrackMutedResult(Participant Self, PublishedTrack Track);

public sealed class SetTrackMutedCommandValidator : AbstractValidator<SetTrackMutedCommand>
{
    public SetTrackMutedCommandValidator()
    {
        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.Source).Must(TrackSources.IsValid).WithMessage(MediaRules.InvalidTrack);
    }
}

public sealed class SetTrackMutedCommandHandler(IRoomStore rooms) : ICommandHandler<SetTrackMutedCommand, SetTrackMutedResult>
{
    public ValueTask<SetTrackMutedResult> Handle(SetTrackMutedCommand command, CancellationToken cancellationToken)
    {
        var source = MediaRules.Source(command.Source);
        var result = rooms.InRoom(command.ConnectionId, (room, self) =>
            {
                var track = room.SetMuted(self.Id, source, command.Muted);
                return new SetTrackMutedResult(room.Find(self.Id)!, track);
            })
            ?? throw new NotFoundException(MediaRules.NotInRoom);

        return ValueTask.FromResult(result);
    }
}
