using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Media;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Admission.Commands.GrantCoHost;

/// <summary>The host makes a guest a co-host: the host identity's signed grant over the guest's identity.</summary>
public sealed record GrantCoHostCommand(string ConnectionId, string? ParticipantId, string? Sig) : ICommand<AuthorityResult>;

/// <summary>The room's authority after a change, for everyone in the call and the lobby.</summary>
public sealed record AuthorityResult(RoomId RoomId, RoomAuthority Authority);

public sealed class GrantCoHostCommandValidator : AbstractValidator<GrantCoHostCommand>
{
    public GrantCoHostCommandValidator()
    {
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.ParticipantId).Must(Domain.Rooms.ParticipantId.IsValid).WithMessage(AdmissionRules.InvalidParticipant);
        RuleFor(c => c.Sig).Must(Base64UrlBytes.IsSignature).WithMessage(AdmissionRules.InvalidSignature);
    }
}

public sealed class GrantCoHostCommandHandler(IRoomStore rooms, ISignatureVerifier verifier) : ICommandHandler<GrantCoHostCommand, AuthorityResult>
{
    public ValueTask<AuthorityResult> Handle(GrantCoHostCommand command, CancellationToken cancellationToken)
    {
        var targetId = new ParticipantId(command.ParticipantId!);
        var result = rooms.InRoom(command.ConnectionId, (room, self) =>
            {
                var target = room.Find(targetId) ?? throw new DomainException(Room.UnknownParticipant);
                var issuer = self.Identity.Ed25519Pub;
                AdmissionMessages.Verify(verifier, issuer, AdmissionMessages.CoHost(room.Id, issuer, target.Identity.Ed25519Pub), command.Sig!);
                room.GrantCoHost(self.Id, targetId, command.Sig!);
                return new AuthorityResult(room.Id, room.Authority());
            })
            ?? throw new NotFoundException(MediaRules.NotInRoom);
        return ValueTask.FromResult(result);
    }
}
