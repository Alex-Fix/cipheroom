using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Media;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Admission.Commands.Knock;

/// <summary>
/// A lobby guest asks to be let in: one knock per admitter online, each carrying the guest's name encrypted to that
/// admitter's identity (opaque to the server, never stored or logged). Sent again when new admitters arrive.
/// </summary>
public sealed record KnockCommand(string ConnectionId, IReadOnlyList<KnockInput?>? Knocks) : ICommand<KnockResult>;

/// <param name="ToId">An admitter (host or co-host) in the call.</param>
/// <param name="Blob">Opaque, end-to-end encrypted knock (base64url).</param>
public sealed record KnockInput(string? ToId, string? Blob);

public sealed record KnockResult(LobbyGuest Guest, IReadOnlyList<KnockDelivery> Deliveries);

public sealed record KnockDelivery(string ConnectionId, string Blob);

public sealed class KnockCommandValidator : AbstractValidator<KnockCommand>
{
    public KnockCommandValidator()
    {
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.Knocks)
            .Must(k => k is { Count: > 0 and <= AdmissionRules.MaxKnocksPerRequest }
                && k.All(x => x is not null && ParticipantId.IsValid(x.ToId) && AdmissionRules.IsKnockBlob(x.Blob))
                && k.Select(x => x!.ToId).Distinct().Count() == k.Count)
            .WithMessage(Room.InvalidKnock);
    }
}

public sealed class KnockCommandHandler(IRoomStore rooms) : ICommandHandler<KnockCommand, KnockResult>
{
    public ValueTask<KnockResult> Handle(KnockCommand command, CancellationToken cancellationToken)
    {
        var knocks = command.Knocks!.Select(k => (To: new ParticipantId(k!.ToId!), Blob: k.Blob!)).ToArray();

        var result = rooms.InAnyRoom(command.ConnectionId, room =>
            {
                var guest = room.Lobby.FirstOrDefault(g => g.ConnectionId == command.ConnectionId)
                    ?? throw new DomainException(Room.NotAllowed);
                var recipients = room.KnockRecipients(guest.Id, [.. knocks.Select(k => k.To)]);
                return new KnockResult(guest, [.. recipients.Zip(knocks, (r, k) => new KnockDelivery(r.ConnectionId, k.Blob))]);
            })
            ?? throw new NotFoundException(MediaRules.NotInRoom);
        return ValueTask.FromResult(result);
    }
}
