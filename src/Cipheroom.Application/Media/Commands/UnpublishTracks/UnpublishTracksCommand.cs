using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Media.Commands.UnpublishTracks;

/// <summary>Stop publishing tracks (e.g. end screen share). Sources that aren't published are ignored.</summary>
public sealed record UnpublishTracksCommand(string ConnectionId, IReadOnlyList<string?>? Sources) : ICommand<UnpublishTracksResult>;

/// <param name="Self">Publisher after the change (for broadcasting to the room).</param>
public sealed record UnpublishTracksResult(Participant Self, IReadOnlyList<PublishedTrack> Removed);

public sealed class UnpublishTracksCommandValidator : AbstractValidator<UnpublishTracksCommand>
{
    public UnpublishTracksCommandValidator()
    {
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.Sources)
            .Must(s => s is { Count: > 0 and <= MediaRules.MaxTracksPerPublish } && s.All(TrackSources.IsValid))
            .WithMessage(MediaRules.InvalidTrack);
    }
}

public sealed class UnpublishTracksCommandHandler(IRoomStore rooms, ISfu sfu) : ICommandHandler<UnpublishTracksCommand, UnpublishTracksResult>
{
    public async ValueTask<UnpublishTracksResult> Handle(UnpublishTracksCommand command, CancellationToken cancellationToken)
    {
        TrackSource[] sources = [.. command.Sources!.Select(MediaRules.Source)];

        // Room state first, so others stop seeing the tracks even if the media server call fails.
        var result = rooms.InRoom(command.ConnectionId, (room, self) =>
            {
                var removed = room.Unpublish(self.Id, sources);
                return new UnpublishTracksResult(room.Find(self.Id)!, removed);
            })
            ?? throw new NotFoundException(MediaRules.NotInRoom);

        if (result.Removed.Count > 0 && result.Self.SfuSessionId is { } sessionId)
            await sfu.CloseTracksAsync(sessionId, [.. result.Removed.Select(t => t.Mid)], cancellationToken);

        return result;
    }
}
