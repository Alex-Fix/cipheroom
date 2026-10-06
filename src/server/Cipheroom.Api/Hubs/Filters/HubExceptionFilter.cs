using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Domain.Common;
using FluentValidation;
using Microsoft.AspNetCore.SignalR;

namespace Cipheroom.Api.Hubs.Filters;

/// <summary>
/// Maps pipeline outcomes to client-facing <see cref="HubException"/>s. Only constant, safe messages reach clients;
/// unexpected errors become a generic message (details stay in the server log, without request values).
/// </summary>
public sealed partial class HubExceptionFilter(ILogger<HubExceptionFilter> logger) : IHubFilter
{
    public const string GenericError = "Something went wrong.";

    public async ValueTask<object?> InvokeMethodAsync(
        HubInvocationContext invocationContext,
        Func<HubInvocationContext, ValueTask<object?>> next)
    {
        try
        {
            return await next(invocationContext);
        }
        catch (ValidationException ex)
        {
            throw new HubException(ex.Errors.FirstOrDefault()?.ErrorMessage ?? "Invalid request.");
        }
        catch (Exception ex) when (ex is DomainException or NotFoundException)
        {
            LogRejected(logger, invocationContext.HubMethodName, ex.Message);
            throw new HubException(ex.Message);
        }
        catch (HubException)
        {
            throw;
        }
        catch (OperationCanceledException) when (invocationContext.Context.ConnectionAborted.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            LogFailed(logger, ex, invocationContext.HubMethodName);
            throw new HubException(GenericError);
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "{HubMethod} rejected: {Reason}")]
    private static partial void LogRejected(ILogger logger, string hubMethod, string reason);

    [LoggerMessage(Level = LogLevel.Error, Message = "{HubMethod} failed")]
    private static partial void LogFailed(ILogger logger, Exception exception, string hubMethod);
}
