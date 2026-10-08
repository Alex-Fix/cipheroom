using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Common.Telemetry;
using Cipheroom.Application.Media;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Admission.Commands.Deny;

/// <summary>A host or co-host turns a lobby guest away (no signature: the server could do that anyway).</summary>
public sealed record DenyCommand(string ConnectionId, string? GuestId) : ICommand<DenyResult>;

/// <param name="Admitters">Who to tell the guest is no longer waiting.</param>
public sealed record DenyResult(LobbyGuest Guest, IReadOnlyList<Participant> Admitters);

public sealed class DenyCommandValidator : AbstractValidator<DenyCommand>
{
    public DenyCommandValidator()
    {
        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.GuestId).Must(ParticipantId.IsValid).WithMessage(AdmissionRules.InvalidParticipant);
    }
}

public sealed class DenyCommandHandler(IRoomStore rooms, TimeProvider time, CipheroomMetrics metrics) : ICommandHandler<DenyCommand, DenyResult>
{
    public ValueTask<DenyResult> Handle(DenyCommand command, CancellationToken cancellationToken)
    {
        var guestId = new ParticipantId(command.GuestId!);
        var result = rooms.InRoom(command.ConnectionId, (room, self) =>
                new DenyResult(room.Deny(self.Id, guestId, time.GetUtcNow()), room.Admitters))
            ?? throw new NotFoundException(MediaRules.NotInRoom);

        metrics.Admission(CipheroomMetrics.AdmissionDenied);
        return ValueTask.FromResult(result);
    }
}
