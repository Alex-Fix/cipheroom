using Cipheroom.Application.Common.Interfaces;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Media.Commands.Renegotiate;

/// <summary>The client's answer to an SFU offer (from SubscribeTracks).</summary>
public sealed record RenegotiateCommand(string ConnectionId, string? AnswerSdp) : ICommand;

public sealed class RenegotiateCommandValidator : AbstractValidator<RenegotiateCommand>
{
    public RenegotiateCommandValidator()
    {
        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.AnswerSdp).Must(MediaRules.IsSdp).WithMessage(MediaRules.InvalidSdp);
    }
}

public sealed class RenegotiateCommandHandler(IRoomStore rooms, ISfu sfu) : ICommandHandler<RenegotiateCommand>
{
    public async ValueTask<Unit> Handle(RenegotiateCommand command, CancellationToken cancellationToken)
    {
        await sfu.RenegotiateAsync(MediaSessions.Require(rooms, command.ConnectionId), command.AnswerSdp!, cancellationToken);
        return Unit.Value;
    }
}
