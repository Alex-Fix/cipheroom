using Mediator;
using Microsoft.Extensions.Logging;

namespace Cipheroom.Application.Common.Behaviours;

public sealed class LoggingBehaviour<TMessage, TResponse>(ILogger<LoggingBehaviour<TMessage, TResponse>> logger)
    : IPipelineBehavior<TMessage, TResponse>
    where TMessage : notnull, IMessage
{
    public ValueTask<TResponse> Handle(
        TMessage message,
        MessageHandlerDelegate<TMessage, TResponse> next,
        CancellationToken cancellationToken)
    {
        Log.Handling(logger, typeof(TMessage).Name);
        return next(message, cancellationToken);
    }
}
