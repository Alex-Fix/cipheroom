using Cipheroom.Application.Common.Interfaces;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Media.Commands.RestartIce;

/// <summary>Client-initiated renegotiation with an ICE-restart offer (network changed or dropped).</summary>
public sealed record RestartIceCommand(string ConnectionId, string? OfferSdp) : ICommand<RestartIceResult>;

public sealed record RestartIceResult(string AnswerSdp);

public sealed class RestartIceCommandValidator : AbstractValidator<RestartIceCommand>
{
    public RestartIceCommandValidator()
    {
        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.OfferSdp).Must(MediaRules.IsSdp).WithMessage(MediaRules.InvalidSdp);
    }
}

public sealed class RestartIceCommandHandler(IRoomStore rooms, ISfu sfu) : ICommandHandler<RestartIceCommand, RestartIceResult>
{
    public async ValueTask<RestartIceResult> Handle(RestartIceCommand command, CancellationToken cancellationToken) =>
        new(await sfu.RestartIceAsync(MediaSessions.Require(rooms, command.ConnectionId), command.OfferSdp!, cancellationToken));
}
