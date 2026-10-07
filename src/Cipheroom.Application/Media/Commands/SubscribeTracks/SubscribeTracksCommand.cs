using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Media.Commands.SubscribeTracks;

/// <summary>Receive other participants' tracks. Only tracks published in the caller's own room can be requested.</summary>
public sealed record SubscribeTracksCommand(string ConnectionId, IReadOnlyList<SubscribeTrackInput>? Tracks)
    : ICommand<SubscribeTracksResult>;

/// <param name="Source">Wire name: microphone, camera or screen.</param>
public sealed record SubscribeTrackInput(string? ParticipantId, string? Source);

/// <param name="Mid">The receiving transceiver on the caller's peer connection.</param>
public sealed record SubscribedTrack(ParticipantId PublisherId, TrackSource Source, string Mid);

/// <param name="OfferSdp">SFU offer the client must answer (via Renegotiate); null when nothing new was added.</param>
public sealed record SubscribeTracksResult(string? OfferSdp, IReadOnlyList<SubscribedTrack> Tracks)
{
    public static readonly SubscribeTracksResult Nothing = new(null, []);
}

public sealed class SubscribeTracksCommandValidator : AbstractValidator<SubscribeTracksCommand>
{
    public SubscribeTracksCommandValidator()
    {
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.Tracks)
            .Must(t => t is { Count: > 0 and <= MediaRules.MaxTracksPerRequest }
                && t.All(x => ParticipantId.IsValid(x?.ParticipantId) && TrackSources.IsValid(x?.Source)))
            .WithMessage(MediaRules.InvalidTrack);
    }
}

public sealed class SubscribeTracksCommandHandler(IRoomStore rooms, ISfu sfu) : ICommandHandler<SubscribeTracksCommand, SubscribeTracksResult>
{
    public async ValueTask<SubscribeTracksResult> Handle(SubscribeTracksCommand command, CancellationToken cancellationToken)
    {
        (ParticipantId, TrackSource)[] wanted =
            [.. command.Tracks!.Select(t => (new ParticipantId(t.ParticipantId!), MediaRules.Source(t.Source)))];

        // Resolve first: a track outside the caller's room fails before any media server call.
        var remote = rooms.InRoom(command.ConnectionId, (room, self) => room.ResolveForSubscribe(self.Id, wanted))
            ?? throw new NotFoundException(MediaRules.NotInRoom);
        if (remote.Count == 0)
            return SubscribeTracksResult.Nothing;

        var self = await MediaSessions.EnsureAsync(rooms, sfu, command.ConnectionId, cancellationToken);
        var pulled = await sfu.SubscribeAsync(
            self.SfuSessionId!,
            [.. remote.Select(r => new SfuRemoteTrack(r.PublisherSfuSessionId, r.Track.Name, Simulcast: r.Track.Source == TrackSource.Camera))],
            cancellationToken);

        SubscribedTrack[] subscribed =
        [
            .. pulled.Tracks.Join(
                remote,
                p => (p.PublisherSessionId, p.TrackName),
                r => (r.PublisherSfuSessionId, r.Track.Name),
                (p, r) => new SubscribedTrack(r.PublisherId, r.Track.Source, p.Mid)),
        ];

        rooms.InRoom(command.ConnectionId, (room, p) =>
        {
            room.Subscribe(p.Id, [.. subscribed.Select(s => new Subscription(s.Mid, s.PublisherId, s.Source))]);
            return subscribed;
        });

        return new SubscribeTracksResult(pulled.OfferSdp, subscribed);
    }
}
