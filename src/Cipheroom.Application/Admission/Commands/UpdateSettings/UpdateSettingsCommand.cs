using Cipheroom.Application.Admission.Commands.GrantCoHost;
using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Media;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Admission.Commands.UpdateSettings;

/// <summary>
/// The host changes room settings (today: auto-admit). Signed with a sequence number that only goes up, so an old
/// setting can't be replayed. Auto-admit is carried out by admitters' browsers, which sign tickets as people knock.
/// </summary>
public sealed record UpdateSettingsCommand(string ConnectionId, long Seq, bool AutoAdmit, string? Sig) : ICommand<AuthorityResult>;

public sealed class UpdateSettingsCommandValidator : AbstractValidator<UpdateSettingsCommand>
{
    public UpdateSettingsCommandValidator()
    {
        ClassLevelCascadeMode = CascadeMode.Stop;

        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.Seq).InclusiveBetween(1, uint.MaxValue).WithMessage(AdmissionRules.InvalidSettings);
        RuleFor(c => c.Sig).Must(Domain.Rooms.Base64UrlBytes.IsSignature).WithMessage(AdmissionRules.InvalidSignature);
    }
}

public sealed class UpdateSettingsCommandHandler(IRoomStore rooms, ISignatureVerifier verifier) : ICommandHandler<UpdateSettingsCommand, AuthorityResult>
{
    public ValueTask<AuthorityResult> Handle(UpdateSettingsCommand command, CancellationToken cancellationToken)
    {
        var seq = (uint)command.Seq;
        var result = rooms.InRoom(command.ConnectionId, (room, self) =>
            {
                var issuer = self.Identity.Ed25519Pub;
                AdmissionMessages.Verify(verifier, issuer, AdmissionMessages.Settings(room.Id, issuer, seq, command.AutoAdmit), command.Sig!);
                room.UpdateSettings(self.Id, seq, command.AutoAdmit, command.Sig!);
                return new AuthorityResult(room.Id, room.Authority());
            })
            ?? throw new NotFoundException(MediaRules.NotInRoom);
        return ValueTask.FromResult(result);
    }
}
