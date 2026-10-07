using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Media.Commands.PublishTracks;

/// <summary>Publish local tracks (mic, camera, screen) from the client's SDP offer.</summary>
public sealed record PublishTracksCommand(string ConnectionId, string? OfferSdp, IReadOnlyList<PublishTrackInput>? Tracks)
    : ICommand<PublishTracksResult>;

/// <param name="Mid">The client's transceiver mid for this track.</param>
/// <param name="Source">Wire name: microphone, camera or screen.</param>
public sealed record PublishTrackInput(string? Mid, string? Source);

/// <param name="Self">Publisher after the change (for broadcasting to the room).</param>
public sealed record PublishTracksResult(string AnswerSdp, Participant Self, IReadOnlyList<PublishedTrack> Tracks);

public sealed class PublishTracksCommandValidator : AbstractValidator<PublishTracksCommand>
{
    public PublishTracksCommandValidator()
    {
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.OfferSdp).Must(MediaRules.IsSdp).WithMessage(MediaRules.InvalidSdp);
        RuleFor(c => c.Tracks)
            .Must(t => t is { Count: > 0 and <= MediaRules.MaxTracksPerPublish }
                && t.All(x => MediaRules.IsMid(x?.Mid) && TrackSources.IsValid(x?.Source))
                && t.Select(x => x.Mid).Distinct().Count() == t.Count
                && t.Select(x => x.Source).Distinct().Count() == t.Count)
            .WithMessage(MediaRules.InvalidTrack);
    }
}

public sealed class PublishTracksCommandHandler(IRoomStore rooms, ISfu sfu) : ICommandHandler<PublishTracksCommand, PublishTracksResult>
{
    public async ValueTask<PublishTracksResult> Handle(PublishTracksCommand command, CancellationToken cancellationToken)
    {
        (TrackSource Source, string Mid)[] tracks = [.. command.Tracks!.Select(t => (MediaRules.Source(t.Source), t.Mid!))];
        TrackSource[] sources = [.. tracks.Select(t => t.Source)];

        // Check the rules before touching the media server.
        _ = rooms.InRoom(command.ConnectionId, (room, self) =>
            {
                room.EnsureCanPublish(self.Id, sources);
                return self;
            })
            ?? throw new NotFoundException(MediaRules.NotInRoom);

        var self = await MediaSessions.EnsureAsync(rooms, sfu, command.ConnectionId, cancellationToken);
        var answer = await sfu.PublishAsync(
            self.SfuSessionId!,
            command.OfferSdp!,
            [.. tracks.Select(t => new SfuLocalTrack(t.Mid, PublishedTrack.NameFor(self.Id, t.Source)))],
            cancellationToken);

        return rooms.InRoom(command.ConnectionId, (room, p) =>
            {
                var published = room.Publish(p.Id, tracks);
                return new PublishTracksResult(answer, room.Find(p.Id)!, published);
            })
            ?? throw new NotFoundException(MediaRules.NotInRoom);
    }
}
