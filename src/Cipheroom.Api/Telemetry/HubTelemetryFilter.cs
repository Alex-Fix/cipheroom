using System.Diagnostics;
using Cipheroom.Api.Hubs.Filters;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Common.Telemetry;
using Microsoft.AspNetCore.SignalR;

namespace Cipheroom.Api.Telemetry;

/// <summary>
/// One root span per hub call (<c>RoomHub/&lt;Method&gt;</c>), so a call's Mediator command and Cloudflare requests
/// show up as its children and every invocation is its own trace (not one trace per WebSocket connection). Tags:
/// pseudonymous room, the random participant id, and the outcome — ok, rejected with the constant client message,
/// or failed. Outermost filter: it also sees rate-limited calls.
/// </summary>
public sealed class HubTelemetryFilter(IRoomStore rooms, TelemetryIds ids, CipheroomMetrics metrics) : IHubFilter
{
    public const string SourceName = "Cipheroom.Api";

    public static readonly ActivitySource Source = new(SourceName);

    public async ValueTask<object?> InvokeMethodAsync(
        HubInvocationContext invocationContext,
        Func<HubInvocationContext, ValueTask<object?>> next)
    {
        var connectionId = invocationContext.Context.ConnectionId;
        var method = invocationContext.HubMethodName;
        using var activity = StartRoot($"RoomHub/{method}");
        var before = activity is null ? null : rooms.FindByConnection(connectionId);
        var outcome = CipheroomMetrics.Failed;
        try
        {
            var result = await next(invocationContext);
            outcome = CipheroomMetrics.Ok;
            return result;
        }
        catch (HubException ex)
        {
            // Client-facing messages are constants (HubExceptionFilter); the generic one means an unexpected failure.
            var failed = ex.Message == HubExceptionFilter.GenericError;
            outcome = failed ? CipheroomMetrics.Failed : CipheroomMetrics.Rejected;
            activity?.SetTag(Tags.Reason, ex.Message);
            if (failed) activity?.SetStatus(ActivityStatusCode.Error);
            throw;
        }
        catch (OperationCanceledException)
        {
            outcome = CipheroomMetrics.Cancelled;
            throw;
        }
        finally
        {
            metrics.HubCall(method, outcome);
            activity?.SetTag(Tags.Outcome, outcome);
            // After JoinRoom the caller is in a room; after LeaveRoom it was.
            if (activity is not null && (rooms.FindByConnection(connectionId) ?? before) is { } participant)
            {
                activity.SetTag(Tags.Room, ids.Room(participant.RoomId.Value));
                activity.SetTag(Tags.Participant, participant.Id.Value);
            }
        }
    }

    public async Task OnDisconnectedAsync(
        HubLifetimeContext context,
        Exception? exception,
        Func<HubLifetimeContext, Exception?, Task> next)
    {
        using var activity = StartRoot("RoomHub/Disconnected");
        if (activity is not null && rooms.FindByConnection(context.Context.ConnectionId) is { } participant)
        {
            activity.SetTag(Tags.Room, ids.Room(participant.RoomId.Value));
            activity.SetTag(Tags.Participant, participant.Id.Value);
        }
        await next(context, exception);
    }

    /// <summary>A new trace, not a child of the long-lived connection request.</summary>
    private static Activity? StartRoot(string name)
    {
        var parent = Activity.Current;
        Activity.Current = null;
        try
        {
            return Source.StartActivity(name, ActivityKind.Server);
        }
        finally
        {
            if (Activity.Current is null) Activity.Current = parent;
        }
    }

    public static class Tags
    {
        public const string Room = "cipheroom.room";
        public const string Participant = "cipheroom.participant";
        public const string Outcome = "cipheroom.outcome";
        public const string Reason = "cipheroom.reason";
    }
}
