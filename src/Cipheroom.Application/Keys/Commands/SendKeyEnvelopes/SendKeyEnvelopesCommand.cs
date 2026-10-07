using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Media;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Keys.Commands.SendKeyEnvelopes;

/// <summary>
/// Relays the caller's sender-key envelopes, each to one other participant of its room. Envelopes are opaque,
/// signed and encrypted end to end: the server checks their shape and recipients only, never stores or logs them.
/// </summary>
public sealed record SendKeyEnvelopesCommand(string ConnectionId, IReadOnlyList<KeyEnvelopeInput?>? Envelopes) : ICommand<SendKeyEnvelopesResult>;

/// <param name="ToId">Recipient participant id.</param>
/// <param name="Blob">Opaque envelope (base64url).</param>
public sealed record KeyEnvelopeInput(string? ToId, string? Blob);

/// <param name="Deliveries">Recipient connection (server-side only) and the envelope for them.</param>
public sealed record SendKeyEnvelopesResult(ParticipantId FromId, IReadOnlyList<KeyEnvelopeDelivery> Deliveries);

public sealed record KeyEnvelopeDelivery(string ConnectionId, string Blob);

public sealed class SendKeyEnvelopesCommandValidator : AbstractValidator<SendKeyEnvelopesCommand>
{
    public SendKeyEnvelopesCommandValidator()
    {
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.Envelopes)
            .Must(e => e is { Count: > 0 and <= KeyRules.MaxEnvelopesPerRequest }
                && e.All(x => x is not null && ParticipantId.IsValid(x.ToId) && KeyRules.IsBlob(x.Blob))
                && e.Select(x => x!.ToId).Distinct().Count() == e.Count)
            .WithMessage(Room.InvalidKeyEnvelope);
    }
}

public sealed class SendKeyEnvelopesCommandHandler(IRoomStore rooms) : ICommandHandler<SendKeyEnvelopesCommand, SendKeyEnvelopesResult>
{
    public ValueTask<SendKeyEnvelopesResult> Handle(SendKeyEnvelopesCommand command, CancellationToken cancellationToken)
    {
        var envelopes = command.Envelopes!.Select(e => (To: new ParticipantId(e!.ToId!), Blob: e.Blob!)).ToArray();

        var result = rooms.InRoom(command.ConnectionId, (room, self) =>
            {
                var recipients = room.EnvelopeRecipients(self.Id, [.. envelopes.Select(e => e.To)]);
                return new SendKeyEnvelopesResult(
                    self.Id,
                    [.. recipients.Zip(envelopes, (r, e) => new KeyEnvelopeDelivery(r.ConnectionId, e.Blob))]);
            })
            ?? throw new NotFoundException(MediaRules.NotInRoom);

        return ValueTask.FromResult(result);
    }
}
