using Cipheroom.Application.Common.Interfaces;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Media.Commands.CloseMediaRelay;

/// <summary>LiveKit mode: livekit-client closed its signaling socket. Unknown ids are fine.</summary>
public sealed record CloseMediaRelayCommand(string ConnectionId, string? RelayId) : ICommand;

public sealed class CloseMediaRelayCommandValidator : AbstractValidator<CloseMediaRelayCommand>
{
    public CloseMediaRelayCommandValidator()
    {
        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.RelayId).Must(MediaRules.IsRelayId).WithMessage(MediaRules.InvalidRelay);
    }
}

public sealed class CloseMediaRelayCommandHandler(IMediaRelay relay) : ICommandHandler<CloseMediaRelayCommand>
{
    public async ValueTask<Unit> Handle(CloseMediaRelayCommand command, CancellationToken cancellationToken)
    {
        await relay.CloseAsync(command.ConnectionId, command.RelayId!);
        return Unit.Value;
    }
}
