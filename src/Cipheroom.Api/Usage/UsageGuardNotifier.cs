using System.Threading.Channels;
using Cipheroom.Api.Hubs;
using Cipheroom.Api.Hubs.Contracts;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Usage.Commands.ApplyUsageLevel;
using Mediator;
using Microsoft.AspNetCore.SignalR;

namespace Cipheroom.Api.Usage;

/// <summary>
/// Carries the usage guard's changes to the calls: on a new level, apply it server-side (layers, video forwarding,
/// ending calls) and tell everyone with <c>UsageChanged</c>; on a new percent only, just tell everyone. Changes are
/// handled one at a time, in order, off the thread that raised them.
/// </summary>
public sealed partial class UsageGuardNotifier(
    IUsageGuard usage,
    IServiceScopeFactory scopes,
    IHubContext<RoomHub, IRoomClient> hub,
    ILogger<UsageGuardNotifier> logger) : BackgroundService
{
    private readonly Channel<UsageStatus> _changes = Channel.CreateUnbounded<UsageStatus>(new() { SingleReader = true });
    private UsageLevel _applied = UsageLevel.Normal;

    public override Task StartAsync(CancellationToken cancellationToken)
    {
        usage.Changed += OnChanged;
        return base.StartAsync(cancellationToken);
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        usage.Changed -= OnChanged;
        await base.StopAsync(cancellationToken);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // A level reached before this started (e.g. restored from the usage file) still has to be applied.
        _changes.Writer.TryWrite(usage.Current);
        try
        {
            await foreach (var status in _changes.Reader.ReadAllAsync(stoppingToken))
            {
                try
                {
                    await HandleAsync(status, stoppingToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    LogFailed(logger, ex, status.Level);
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Shutting down.
        }
    }

    private void OnChanged(UsageStatus status) => _changes.Writer.TryWrite(status);

    private async Task HandleAsync(UsageStatus status, CancellationToken cancellationToken)
    {
        if (status.Level != _applied)
        {
            _applied = status.Level;
            await using var scope = scopes.CreateAsyncScope();
            var mediator = scope.ServiceProvider.GetRequiredService<IMediator>();
            var result = await mediator.Send(new ApplyUsageLevelCommand(status.Level), cancellationToken);
            foreach (var ended in result.Ended)
            {
                await hub.Groups.RemoveFromGroupAsync(ended.ConnectionId, RoomHub.GroupName(ended.RoomId.Value), cancellationToken);
                await hub.Groups.RemoveFromGroupAsync(ended.ConnectionId, RoomHub.LobbyGroupName(ended.RoomId.Value), cancellationToken);
            }
        }
        await hub.Clients.All.UsageChanged(UsageDto.From(status));
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Usage guard: applying level {Level} failed")]
    private static partial void LogFailed(ILogger logger, Exception exception, UsageLevel level);
}
