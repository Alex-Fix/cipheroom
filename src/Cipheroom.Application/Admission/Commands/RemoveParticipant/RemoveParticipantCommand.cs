using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Common.Telemetry;
using Cipheroom.Application.Media;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Admission.Commands.RemoveParticipant;

/// <summary>
/// A host (anyone) or co-host (guests only) removes someone with a signed revocation of their identity. The server
/// drops them from the call and stops what their media session receives; clients stop sending them keys and rotate.
/// </summary>
public sealed record RemoveParticipantCommand(string ConnectionId, string? ParticipantId, string? Sig) : ICommand<RemoveParticipantResult>;

public sealed record RemoveParticipantResult(Participant Removed, RoomAuthority Authority);

public sealed class RemoveParticipantCommandValidator : AbstractValidator<RemoveParticipantCommand>
{
    public RemoveParticipantCommandValidator()
    {
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.ParticipantId).Must(Domain.Rooms.ParticipantId.IsValid).WithMessage(AdmissionRules.InvalidParticipant);
        RuleFor(c => c.Sig).Must(Base64UrlBytes.IsSignature).WithMessage(AdmissionRules.InvalidSignature);
    }
}

public sealed class RemoveParticipantCommandHandler(IRoomStore rooms, ISignatureVerifier verifier, ISfu sfu, CipheroomMetrics metrics)
    : ICommandHandler<RemoveParticipantCommand, RemoveParticipantResult>
{
    public async ValueTask<RemoveParticipantResult> Handle(RemoveParticipantCommand command, CancellationToken cancellationToken)
    {
        var targetId = new ParticipantId(command.ParticipantId!);
        var result = rooms.InRoom(command.ConnectionId, (room, self) =>
            {
                var target = room.Find(targetId) ?? throw new DomainException(Room.UnknownParticipant);
                var issuer = self.Identity.Ed25519Pub;
                AdmissionMessages.Verify(verifier, issuer, AdmissionMessages.Revoke(room.Id, issuer, target.Identity.Ed25519Pub), command.Sig!);
                return new RemoveParticipantResult(room.Remove(self.Id, targetId, command.Sig!), room.Authority());
            })
            ?? throw new NotFoundException(MediaRules.NotInRoom);
        metrics.Admission(CipheroomMetrics.AdmissionRemoved);

        // Stop forwarding to them at once instead of waiting for their browser to leave.
        var removed = result.Removed;
        string[] mids = [.. removed.Subscriptions.Select(s => s.Mid), .. removed.Tracks.Select(t => t.Mid)];
        if (removed.SfuSessionId is { } session && mids.Length > 0)
        {
            try
            {
                await sfu.CloseTracksAsync(session, [.. mids.Distinct()], cancellationToken);
            }
            catch (MediaServerException)
            {
                // Best effort: they're out of the room and get no more keys; the session expires on its own.
            }
        }
        return result;
    }
}
