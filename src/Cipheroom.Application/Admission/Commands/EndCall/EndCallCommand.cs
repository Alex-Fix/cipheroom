using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Common.Telemetry;
using Cipheroom.Application.Media;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Admission.Commands.EndCall;

/// <summary>A host or co-host ends the call for everyone (signed, so clients can tell it really was them).</summary>
public sealed record EndCallCommand(string ConnectionId, string? Sig) : ICommand<EndCallResult>;

/// <param name="Connections">Everyone who was in the call or the lobby (all of them are out now).</param>
public sealed record EndCallResult(RoomId RoomId, string Issuer, string Sig, IReadOnlyList<string> Connections);

public sealed class EndCallCommandValidator : AbstractValidator<EndCallCommand>
{
    public EndCallCommandValidator()
    {
        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.Sig).Must(Base64UrlBytes.IsSignature).WithMessage(AdmissionRules.InvalidSignature);
    }
}

public sealed class EndCallCommandHandler(IRoomStore rooms, ISignatureVerifier verifier, CipheroomMetrics metrics) : ICommandHandler<EndCallCommand, EndCallResult>
{
    public ValueTask<EndCallResult> Handle(EndCallCommand command, CancellationToken cancellationToken)
    {
        var result = rooms.InRoom(command.ConnectionId, (room, self) =>
            {
                room.RequireAdmitter(self.Id);
                var issuer = self.Identity.Ed25519Pub;
                AdmissionMessages.Verify(verifier, issuer, AdmissionMessages.End(room.Id, issuer), command.Sig!);
                return new EndCallResult(room.Id, issuer, command.Sig!, room.End(self.Id));
            })
            ?? throw new NotFoundException(MediaRules.NotInRoom);

        metrics.Admission(CipheroomMetrics.AdmissionEnded);
        return ValueTask.FromResult(result);
    }
}
