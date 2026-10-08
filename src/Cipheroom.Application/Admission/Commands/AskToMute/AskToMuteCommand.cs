using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Media;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Admission.Commands.AskToMute;

/// <summary>
/// A host or co-host asks someone to mute. Advisory: the target's browser mutes and they may unmute. Signed (with a
/// sequence number) so the server can't fake or replay a "the host muted you".
/// </summary>
public sealed record AskToMuteCommand(string ConnectionId, string? ParticipantId, long Seq, string? Sig) : ICommand<AskToMuteResult>;

public sealed record AskToMuteResult(ParticipantId FromId, string TargetConnectionId, uint Seq, string Sig);

public sealed class AskToMuteCommandValidator : AbstractValidator<AskToMuteCommand>
{
    public AskToMuteCommandValidator()
    {
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.ParticipantId).Must(Domain.Rooms.ParticipantId.IsValid).WithMessage(AdmissionRules.InvalidParticipant);
        RuleFor(c => c.Seq).InclusiveBetween(1, uint.MaxValue).WithMessage(AdmissionRules.InvalidSignature);
        RuleFor(c => c.Sig).Must(Base64UrlBytes.IsSignature).WithMessage(AdmissionRules.InvalidSignature);
    }
}

public sealed class AskToMuteCommandHandler(IRoomStore rooms, ISignatureVerifier verifier) : ICommandHandler<AskToMuteCommand, AskToMuteResult>
{
    public ValueTask<AskToMuteResult> Handle(AskToMuteCommand command, CancellationToken cancellationToken)
    {
        var targetId = new ParticipantId(command.ParticipantId!);
        var seq = (uint)command.Seq;
        var result = rooms.InRoom(command.ConnectionId, (room, self) =>
            {
                var target = room.MuteTarget(self.Id, targetId);
                var issuer = self.Identity.Ed25519Pub;
                AdmissionMessages.Verify(verifier, issuer, AdmissionMessages.Mute(room.Id, issuer, target.Identity.Ed25519Pub, seq), command.Sig!);
                return new AskToMuteResult(self.Id, target.ConnectionId, seq, command.Sig!);
            })
            ?? throw new NotFoundException(MediaRules.NotInRoom);
        return ValueTask.FromResult(result);
    }
}

