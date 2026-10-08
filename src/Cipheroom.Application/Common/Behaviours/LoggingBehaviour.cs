using System.Diagnostics;
using Cipheroom.Application.Common.Telemetry;
using Mediator;
using Microsoft.Extensions.Logging;

namespace Cipheroom.Application.Common.Behaviours;

/// <summary>Logs and traces every request by type only — never its values.</summary>
public sealed class LoggingBehaviour<TMessage, TResponse>(ILogger<LoggingBehaviour<TMessage, TResponse>> logger)
    : IPipelineBehavior<TMessage, TResponse>
    where TMessage : notnull, IMessage
{
    public async ValueTask<TResponse> Handle(
        TMessage message,
        MessageHandlerDelegate<TMessage, TResponse> next,
        CancellationToken cancellationToken)
    {
        var name = typeof(TMessage).Name;
        using var activity = ApplicationTelemetry.Source.StartActivity(name);
        Log.Handling(logger, name);
        try
        {
            return await next(message, cancellationToken);
        }
        catch (Exception ex)
        {
            // The exception type only: messages may carry details we don't export.
            activity?.SetStatus(ActivityStatusCode.Error, ex.GetType().Name);
            throw;
        }
    }
}
