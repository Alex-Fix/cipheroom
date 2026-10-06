using Cipheroom.Api.Hubs.Contracts;
using Cipheroom.Application.Rooms.Commands.JoinRoom;
using Cipheroom.Application.Rooms.Commands.LeaveRoom;
using Cipheroom.Application.Rtc.Queries.GetRtcConfig;
using Mediator;
using Microsoft.AspNetCore.SignalR;

namespace Cipheroom.Api.Hubs;

/// <summary>
/// Thin SignalR adapter: each method sends one Mediator request, then does the SignalR-only work (groups, events).
/// Validation and errors are handled by the pipeline and <see cref="Filters.HubExceptionFilter"/>.
/// </summary>
public sealed partial class RoomHub(IMediator mediator, ILogger<RoomHub> logger) : Hub<IRoomClient>
{
    public async Task<JoinResult> JoinRoom(string? roomId, string? displayName)
    {
        var result = await mediator.Send(new JoinRoomCommand(Context.ConnectionId, roomId, displayName), Context.ConnectionAborted);
        var self = result.Self;

        await Groups.AddToGroupAsync(Context.ConnectionId, GroupName(self.RoomId.Value));
        await Clients.OthersInGroup(GroupName(self.RoomId.Value)).ParticipantJoined(ParticipantDto.From(self));

        LogJoined(logger, self.Id.Value, self.RoomId.Value);
        return new JoinResult(self.Id.Value, [.. result.Others.Select(ParticipantDto.From)]);
    }

    public async Task<RtcConfig> GetRtcConfig() =>
        RtcConfig.From(await mediator.Send(new GetRtcConfigQuery(Context.ConnectionId), Context.ConnectionAborted));

    public Task LeaveRoom() => LeaveAsync();

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        await LeaveAsync();
        await base.OnDisconnectedAsync(exception);
    }

    private async Task LeaveAsync()
    {
        // Not Context.ConnectionAborted: leaving must complete even while the connection is going away.
        if (await mediator.Send(new LeaveRoomCommand(Context.ConnectionId)) is not { } left)
            return;

        await Groups.RemoveFromGroupAsync(Context.ConnectionId, GroupName(left.RoomId.Value));
        await Clients.Group(GroupName(left.RoomId.Value)).ParticipantLeft(left.Id.Value);
        LogLeft(logger, left.Id.Value, left.RoomId.Value);
    }

    private static string GroupName(string roomId) => $"room:{roomId}";

    [LoggerMessage(Level = LogLevel.Information, Message = "Participant {ParticipantId} joined room {RoomId}")]
    private static partial void LogJoined(ILogger logger, string participantId, string roomId);

    [LoggerMessage(Level = LogLevel.Information, Message = "Participant {ParticipantId} left room {RoomId}")]
    private static partial void LogLeft(ILogger logger, string participantId, string roomId);
}
