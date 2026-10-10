using Cipheroom.Application.Files;
using Cipheroom.Application.Files.Commands.CloseExpiredDataChannels;
using Mediator;

namespace Cipheroom.Api.Files;

/// <summary>
/// Closes file-transfer data channels once they are older than <see cref="FileRules.ChannelLifetime"/>, checking every
/// 30 seconds. Bounds how long a modified client can stream on one channel (the server can't see what flows).
/// </summary>
public sealed partial class DataChannelExpiry(IServiceScopeFactory scopes, TimeProvider time, ILogger<DataChannelExpiry> logger) : BackgroundService
{
    public static readonly TimeSpan Interval = TimeSpan.FromSeconds(30);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval, time);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                try
                {
                    await using var scope = scopes.CreateAsyncScope();
                    await scope.ServiceProvider.GetRequiredService<IMediator>().Send(new CloseExpiredDataChannelsCommand(), stoppingToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    LogFailed(logger, ex);
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Shutting down.
        }
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Closing expired data channels failed")]
    private static partial void LogFailed(ILogger logger, Exception exception);
}
