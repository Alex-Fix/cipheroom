using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Media.Commands.AnnounceTracks;

/// <summary>
/// LiveKit mode: the browser published these sources on LiveKit; the room learns them like a Cloudflare publish (the
/// rest of the call — tiles, mute state, who receives what — reads the room, whatever the provider).
/// </summary>
/// <param name="Sources">Wire names: microphone, camera, screen.</param>
public sealed record AnnounceTracksCommand(string ConnectionId, IReadOnlyList<string?>? Sources) : ICommand<AnnounceTracksResult>;

/// <param name="Self">Publisher after the change (for broadcasting to the room).</param>
public sealed record AnnounceTracksResult(Participant Self, IReadOnlyList<PublishedTrack> Tracks);

public sealed class AnnounceTracksCommandValidator : AbstractValidator<AnnounceTracksCommand>
{
    public AnnounceTracksCommandValidator()
    {
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.Sources)
            .Must(s => s is { Count: > 0 and <= MediaRules.MaxTracksPerPublish }
                && s.All(TrackSources.IsValid)
                && s.Distinct().Count() == s.Count)
            .WithMessage(MediaRules.InvalidTrack);
    }
}

public sealed class AnnounceTracksCommandHandler(IRoomStore rooms, IMediaRoom media) : ICommandHandler<AnnounceTracksCommand, AnnounceTracksResult>
{
    public ValueTask<AnnounceTracksResult> Handle(AnnounceTracksCommand command, CancellationToken cancellationToken)
    {
        MediaSessions.RequireProvider(media, MediaProvider.LiveKit);
        TrackSource[] sources = [.. command.Sources!.Select(MediaRules.Source)];

        var result = rooms.InRoom(command.ConnectionId, (room, self) =>
            {
                var published = room.Announce(self.Id, sources);
                return new AnnounceTracksResult(room.Find(self.Id)!, published);
            })
            ?? throw new NotFoundException(MediaRules.NotInRoom);
        return ValueTask.FromResult(result);
    }
}
