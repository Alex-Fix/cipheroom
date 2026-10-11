using Cipheroom.Application.Common.Interfaces;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Media.Commands.SendMediaRelay;

/// <summary>LiveKit mode: one signaling message upstream, base64 (opaque: SDP and ICE candidates, never logged).</summary>
public sealed record SendMediaRelayCommand(string ConnectionId, string? RelayId, string? Message, bool Text) : ICommand;

public sealed class SendMediaRelayCommandValidator : AbstractValidator<SendMediaRelayCommand>
{
    public SendMediaRelayCommandValidator()
    {
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c).Must(c => MediaRules.IsRelayId(c.RelayId) && MediaRules.IsRelayMessage(c.Message))
            .WithMessage(MediaRules.InvalidRelay);
    }
}

public sealed class SendMediaRelayCommandHandler(IMediaRelay relay) : ICommandHandler<SendMediaRelayCommand>
{
    public async ValueTask<Unit> Handle(SendMediaRelayCommand command, CancellationToken cancellationToken)
    {
        byte[] message;
        try
        {
            message = Convert.FromBase64String(command.Message!);
        }
        catch (FormatException)
        {
            throw new FluentValidation.ValidationException(MediaRules.InvalidRelay);
        }

        // Only the owner's relays are found: an id from another connection is simply unknown.
        await relay.SendAsync(command.ConnectionId, command.RelayId!, message, command.Text, cancellationToken);
        return Unit.Value;
    }
}
