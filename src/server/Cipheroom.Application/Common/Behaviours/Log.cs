using Microsoft.Extensions.Logging;

namespace Cipheroom.Application.Common.Behaviours;

/// <summary>
/// Behaviour log messages. Only the request type is logged — never request values (display names today;
/// key envelopes and ciphertext later must never reach logs).
/// </summary>
internal static partial class Log
{
    [LoggerMessage(Level = LogLevel.Debug, Message = "Handling {RequestName}")]
    public static partial void Handling(ILogger logger, string requestName);

    [LoggerMessage(Level = LogLevel.Debug, Message = "{RequestName} failed validation: {Properties}")]
    public static partial void ValidationFailed(ILogger logger, string requestName, string properties);

    [LoggerMessage(Level = LogLevel.Error, Message = "Unhandled exception for {RequestName}")]
    public static partial void Unhandled(ILogger logger, Exception exception, string requestName);
}
