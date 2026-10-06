using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Domain.Common;
using FluentValidation;
using Mediator;
using Microsoft.Extensions.Logging;

namespace Cipheroom.Application.Common.Behaviours;

/// <summary>Logs unexpected failures (not validation/business/not-found outcomes) and rethrows.</summary>
public sealed class UnhandledExceptionBehaviour<TMessage, TResponse>(
    ILogger<UnhandledExceptionBehaviour<TMessage, TResponse>> logger)
    : IPipelineBehavior<TMessage, TResponse>
    where TMessage : notnull, IMessage
{
    public async ValueTask<TResponse> Handle(
        TMessage message,
        MessageHandlerDelegate<TMessage, TResponse> next,
        CancellationToken cancellationToken)
    {
        try
        {
            return await next(message, cancellationToken);
        }
        catch (Exception ex) when (ex is not (ValidationException or DomainException or NotFoundException or OperationCanceledException))
        {
            Log.Unhandled(logger, ex, typeof(TMessage).Name);
            throw;
        }
    }
}
