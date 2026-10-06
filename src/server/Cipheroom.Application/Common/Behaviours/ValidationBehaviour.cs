using FluentValidation;
using Mediator;
using Microsoft.Extensions.Logging;

namespace Cipheroom.Application.Common.Behaviours;

/// <summary>Runs every FluentValidation validator for the message before its handler.</summary>
public sealed class ValidationBehaviour<TMessage, TResponse>(
    IEnumerable<IValidator<TMessage>> validators,
    ILogger<ValidationBehaviour<TMessage, TResponse>> logger)
    : IPipelineBehavior<TMessage, TResponse>
    where TMessage : notnull, IMessage
{
    public async ValueTask<TResponse> Handle(
        TMessage message,
        MessageHandlerDelegate<TMessage, TResponse> next,
        CancellationToken cancellationToken)
    {
        var failures = new List<FluentValidation.Results.ValidationFailure>();
        foreach (var validator in validators)
        {
            var result = await validator.ValidateAsync(message, cancellationToken);
            failures.AddRange(result.Errors);
        }

        if (failures.Count > 0)
        {
            if (logger.IsEnabled(LogLevel.Debug))
            {
                var properties = string.Join(", ", failures.Select(f => f.PropertyName).Distinct());
                Log.ValidationFailed(logger, typeof(TMessage).Name, properties);
            }
            throw new ValidationException(failures);
        }

        return await next(message, cancellationToken);
    }
}
