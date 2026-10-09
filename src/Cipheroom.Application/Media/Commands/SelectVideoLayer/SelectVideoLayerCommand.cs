using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Usage;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Media.Commands.SelectVideoLayer;

/// <summary>Choose the simulcast layer (f = full, h = half, q = quarter) of a received camera track.</summary>
public sealed record SelectVideoLayerCommand(string ConnectionId, string? Mid, string? Rid) : ICommand;

public sealed class SelectVideoLayerCommandValidator : AbstractValidator<SelectVideoLayerCommand>
{
    public SelectVideoLayerCommandValidator()
    {
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.Mid).Must(MediaRules.IsMid).WithMessage(MediaRules.InvalidTrack);
        RuleFor(c => c.Rid).Must(r => r is not null && MediaRules.Layers.Contains(r)).WithMessage(MediaRules.InvalidLayer);
    }
}

public sealed class SelectVideoLayerCommandHandler(IRoomStore rooms, ISfu sfu, IUsageGuard usage) : ICommandHandler<SelectVideoLayerCommand>
{
    public async ValueTask<Unit> Handle(SelectVideoLayerCommand command, CancellationToken cancellationToken)
    {
        var target = rooms.InRoom(command.ConnectionId, (room, self) => new Target(self.SfuSessionId, room.FindSubscription(self.Id, command.Mid!)))
            ?? throw new NotFoundException(MediaRules.NotInRoom);

        // Only camera tracks are sent with simulcast layers.
        if (target.Session is null || target.Remote.Track.Source != TrackSource.Camera)
            throw new DomainException(Room.UnknownTrack);

        await sfu.SelectLayerAsync(
            target.Session,
            command.Mid!,
            new SfuRemoteTrack(target.Remote.PublisherSfuSessionId, target.Remote.Track.Name, Simulcast: true),
            // Usage guard: while saving (or later), never the full layer.
            usage.Current.Level >= UsageLevel.Saving && command.Rid == "f" ? UsageLayers.Half : command.Rid!,
            cancellationToken);
        return Unit.Value;
    }

    private sealed record Target(string? Session, RemoteTrack Remote);
}
