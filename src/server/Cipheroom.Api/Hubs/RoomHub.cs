using System.Text.RegularExpressions;
using Cipheroom.Api.Hubs.Contracts;
using Cipheroom.Api.Rooms;
using Cipheroom.Api.Rtc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;

namespace Cipheroom.Api.Hubs;

public sealed partial class RoomHub(
    IRoomRegistry rooms,
    LiveKitTokenService tokens,
    IIceServerProvider iceServers,
    IOptions<LiveKitOptions> liveKit,
    ILogger<RoomHub> logger) : Hub<IRoomClient>
{
    private const int MaxDisplayNameLength = 64;

    public async Task<JoinResult> JoinRoom(string roomId, string displayName)
    {
        // Clients are untrusted: SignalR will happily bind null to non-nullable parameters.
        roomId ??= "";
        if (!RoomIdPattern().IsMatch(roomId))
            throw new HubException("Invalid room id.");

        displayName = displayName?.Trim() ?? "";
        if (displayName.Length is 0 or > MaxDisplayNameLength)
            throw new HubException("Display name must be 1-64 characters.");

        if (!rooms.TryJoin(roomId, Context.ConnectionId, displayName, out var self, out var others))
            throw new HubException("Already in a room.");

        await Groups.AddToGroupAsync(Context.ConnectionId, GroupName(roomId));
        await Clients.OthersInGroup(GroupName(roomId)).ParticipantJoined(self.ToDto());

        logger.LogInformation("Participant {ParticipantId} joined room {RoomId}", self.Id, roomId);
        return new JoinResult(self.Id, others.Select(p => p.ToDto()).ToList());
    }

    public async Task<RtcConfig> GetRtcConfig()
    {
        var self = rooms.Find(Context.ConnectionId) ?? throw new HubException("Join a room first.");
        var ice = await iceServers.GetAsync(self.Id, Context.ConnectionAborted);
        var token = tokens.Create(self.RoomId, self.Id, self.DisplayName);
        return new RtcConfig(liveKit.Value.Url, token, ice.IceServers, ice.ForceRelay);
    }

    public Task LeaveRoom() => LeaveAsync();

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        await LeaveAsync();
        await base.OnDisconnectedAsync(exception);
    }

    private async Task LeaveAsync()
    {
        if (rooms.Leave(Context.ConnectionId) is not { } left)
            return;

        await Groups.RemoveFromGroupAsync(Context.ConnectionId, GroupName(left.RoomId));
        await Clients.Group(GroupName(left.RoomId)).ParticipantLeft(left.Id);
        logger.LogInformation("Participant {ParticipantId} left room {RoomId}", left.Id, left.RoomId);
    }

    private static string GroupName(string roomId) => $"room:{roomId}";

    [GeneratedRegex("^[a-z0-9-]{3,64}$")]
    private static partial Regex RoomIdPattern();
}
