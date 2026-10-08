using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Common.Telemetry;
using Cipheroom.Application.Media;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Admission.Commands.Admit;

/// <summary>
/// A host or co-host lets a lobby guest in with a ticket: their identity's signature over the guest's identity. The
/// server checks it before moving the guest into the call; every client checks it again before exchanging keys.
/// </summary>
public sealed record AdmitCommand(string ConnectionId, string? GuestId, string? Sig) : ICommand<AdmitResult>;

/// <param name="Others">Who was in the call before (what the admitted guest gets as the participant list).</param>
public sealed record AdmitResult(Participant Admitted, IReadOnlyList<Participant> Others, RoomAuthority Authority);

public sealed class AdmitCommandValidator : AbstractValidator<AdmitCommand>
{
    public AdmitCommandValidator()
    {
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.GuestId).Must(ParticipantId.IsValid).WithMessage(AdmissionRules.InvalidParticipant);
        RuleFor(c => c.Sig).Must(Base64UrlBytes.IsSignature).WithMessage(AdmissionRules.InvalidSignature);
    }
}

public sealed class AdmitCommandHandler(IRoomStore rooms, ISignatureVerifier verifier, CipheroomMetrics metrics) : ICommandHandler<AdmitCommand, AdmitResult>
{
    public ValueTask<AdmitResult> Handle(AdmitCommand command, CancellationToken cancellationToken)
    {
        var guestId = new ParticipantId(command.GuestId!);

        var result = rooms.InRoom(command.ConnectionId, (room, self) =>
            {
                room.RequireAdmitter(self.Id);
                var guest = room.Lobby.FirstOrDefault(g => g.Id == guestId) ?? throw new DomainException(Room.UnknownParticipant);
                var issuer = self.Identity.Ed25519Pub;
                AdmissionMessages.Verify(verifier, issuer, AdmissionMessages.Ticket(room.Id, issuer, guest.Identity.Ed25519Pub), command.Sig!);

                Participant[] others = [.. room.Participants];
                var admitted = room.Admit(self.Id, guestId, command.Sig!);
                return new AdmitResult(admitted, others, room.Authority());
            })
            ?? throw new NotFoundException(MediaRules.NotInRoom);

        metrics.Admission(CipheroomMetrics.AdmissionAdmitted);
        return ValueTask.FromResult(result);
    }
}
