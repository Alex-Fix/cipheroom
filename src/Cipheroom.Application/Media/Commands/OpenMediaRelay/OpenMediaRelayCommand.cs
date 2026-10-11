using Cipheroom.Application.Common.Interfaces;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Media.Commands.OpenMediaRelay;

/// <summary>
/// LiveKit mode: opens a relay for livekit-client's signaling socket. Only admitted members get one (knocking guests
/// get "Not admitted.", like a media session); the api attaches its own token, so the browser never holds one.
/// </summary>
/// <param name="RelayId">Chosen by the browser: it registers the socket before LiveKit's first message arrives.</param>
/// <param name="Path">LiveKit's signaling path.</param>
/// <param name="Query">livekit-client's connect parameters (opaque; reduced to an allowlist by the relay).</param>
public sealed record OpenMediaRelayCommand(string ConnectionId, string? RelayId, string? Path, string? Query) : ICommand;

public sealed class OpenMediaRelayCommandValidator : AbstractValidator<OpenMediaRelayCommand>
{
    public OpenMediaRelayCommandValidator()
    {
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c).Must(c => MediaRules.IsRelayId(c.RelayId) && MediaRules.IsRelayPath(c.Path) && MediaRules.IsRelayQuery(c.Query))
            .WithMessage(MediaRules.InvalidRelay);
    }
}

public sealed class OpenMediaRelayCommandHandler(IRoomStore rooms, IMediaRoom media, IMediaRelay relay) : ICommandHandler<OpenMediaRelayCommand>
{
    public async ValueTask<Unit> Handle(OpenMediaRelayCommand command, CancellationToken cancellationToken)
    {
        MediaSessions.RequireProvider(media, MediaProvider.LiveKit);
        var self = MediaSessions.Member(rooms, command.ConnectionId);
        await relay.OpenAsync(new MediaRelayOwner(command.ConnectionId, self.RoomId, self.Id), command.RelayId!, command.Path!, command.Query ?? "", cancellationToken);
        return Unit.Value;
    }
}
