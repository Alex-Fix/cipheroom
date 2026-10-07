using Cipheroom.Api.Hubs.Contracts;
using Cipheroom.Api.Telemetry;
using Cipheroom.Application.Keys.Commands.SendKeyEnvelopes;
using Cipheroom.Application.Media.Commands.PublishTracks;
using Cipheroom.Application.Media.Commands.Renegotiate;
using Cipheroom.Application.Media.Commands.RestartIce;
using Cipheroom.Application.Media.Commands.SelectVideoLayer;
using Cipheroom.Application.Media.Commands.SetTrackMuted;
using Cipheroom.Application.Media.Commands.SubscribeTracks;
using Cipheroom.Application.Media.Commands.UnpublishTracks;
using Cipheroom.Application.Media.Commands.UnsubscribeTracks;
using Cipheroom.Application.Rooms.Commands.JoinRoom;
using Cipheroom.Application.Rooms.Commands.LeaveRoom;
using Cipheroom.Application.Rtc.Queries.GetRtcConfig;
using Cipheroom.Domain.Rooms;
using Mediator;
using Microsoft.AspNetCore.SignalR;

namespace Cipheroom.Api.Hubs;

/// <summary>
/// Thin SignalR adapter: each method sends one Mediator request, then does the SignalR-only work (groups, events).
/// Validation and errors are handled by the pipeline and <see cref="Filters.HubExceptionFilter"/>.
/// </summary>
public sealed partial class RoomHub(IMediator mediator, TelemetryIds ids, ILogger<RoomHub> logger) : Hub<IRoomClient>
{
    public async Task<JoinResult> JoinRoom(string? roomId, string? displayName, IdentityDto? identity)
    {
        var result = await mediator.Send(
            new JoinRoomCommand(
                Context.ConnectionId,
                roomId,
                displayName,
                identity is null ? null : new IdentityInput(identity.Ed25519Pub, identity.X25519Pub, identity.Sig)),
            Context.ConnectionAborted);
        var self = result.Self;

        await Groups.AddToGroupAsync(Context.ConnectionId, GroupName(self.RoomId.Value));
        await Clients.OthersInGroup(GroupName(self.RoomId.Value)).ParticipantJoined(ParticipantDto.From(self));

        if (logger.IsEnabled(LogLevel.Information))
        {
            var room = ids.Room(self.RoomId.Value);
            LogJoined(logger, self.Id.Value, room);
        }
        return new JoinResult(self.Id.Value, [.. result.Others.Select(ParticipantDto.From)]);
    }

    public async Task<RtcConfig> GetRtcConfig() =>
        RtcConfig.From(await mediator.Send(new GetRtcConfigQuery(Context.ConnectionId), Context.ConnectionAborted));

    public Task LeaveRoom() => LeaveAsync();

    // Media (Cloudflare Realtime SFU). SDP passes through to the media server; it is never logged.

    public async Task<AnswerDto> PublishTracks(string? offerSdp, IReadOnlyList<PublishTrackDto?>? tracks)
    {
        var result = await mediator.Send(
            new PublishTracksCommand(Context.ConnectionId, offerSdp, tracks?.Select(t => new PublishTrackInput(t?.Mid, t?.Source)).ToArray()),
            Context.ConnectionAborted);

        await Clients.OthersInGroup(GroupName(result.Self)).TracksPublished(result.Self.Id.Value, [.. result.Tracks.Select(TrackDto.From)]);
        return new AnswerDto(result.AnswerSdp);
    }

    public async Task<SubscribeResult> SubscribeTracks(IReadOnlyList<TrackRefDto?>? tracks) =>
        SubscribeResult.From(await mediator.Send(
            new SubscribeTracksCommand(Context.ConnectionId, tracks?.Select(t => new SubscribeTrackInput(t?.ParticipantId, t?.Source)).ToArray()),
            Context.ConnectionAborted));

    public async Task Renegotiate(string? answerSdp) =>
        await mediator.Send(new RenegotiateCommand(Context.ConnectionId, answerSdp), Context.ConnectionAborted);

    public async Task<AnswerDto> RestartIce(string? offerSdp) =>
        new((await mediator.Send(new RestartIceCommand(Context.ConnectionId, offerSdp), Context.ConnectionAborted)).AnswerSdp);

    public async Task UnpublishTracks(IReadOnlyList<string?>? sources)
    {
        var result = await mediator.Send(new UnpublishTracksCommand(Context.ConnectionId, sources), Context.ConnectionAborted);
        if (result.Removed.Count > 0)
            await Clients.OthersInGroup(GroupName(result.Self)).TracksUnpublished(result.Self.Id.Value, [.. result.Removed.Select(t => t.Source.ToWire())]);
    }

    public async Task UnsubscribeTracks(IReadOnlyList<string?>? mids) =>
        await mediator.Send(new UnsubscribeTracksCommand(Context.ConnectionId, mids), Context.ConnectionAborted);

    public async Task SetTrackMuted(string? source, bool muted)
    {
        var result = await mediator.Send(new SetTrackMutedCommand(Context.ConnectionId, source, muted), Context.ConnectionAborted);
        await Clients.OthersInGroup(GroupName(result.Self)).TrackMuted(result.Self.Id.Value, result.Track.Source.ToWire(), result.Track.Muted);
    }

    public async Task SelectVideoLayer(string? mid, string? rid) =>
        await mediator.Send(new SelectVideoLayerCommand(Context.ConnectionId, mid, rid), Context.ConnectionAborted);

    // End-to-end keys. Envelopes are relayed to their recipient only; they are never stored or logged.

    public async Task SendKeyEnvelopes(IReadOnlyList<KeyEnvelopeDto?>? envelopes)
    {
        var result = await mediator.Send(
            new SendKeyEnvelopesCommand(Context.ConnectionId, envelopes?.Select(e => e is null ? null : new KeyEnvelopeInput(e.ToId, e.Blob)).ToArray()),
            Context.ConnectionAborted);

        await Task.WhenAll(result.Deliveries.Select(d => Clients.Client(d.ConnectionId).KeyEnvelopeReceived(result.FromId.Value, d.Blob)));
    }

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
        if (logger.IsEnabled(LogLevel.Information))
        {
            var room = ids.Room(left.RoomId.Value);
            LogLeft(logger, left.Id.Value, room);
        }
    }

    private static string GroupName(string roomId) => $"room:{roomId}";

    private static string GroupName(Participant participant) => GroupName(participant.RoomId.Value);

    // Room ids are logged pseudonymously (TelemetryIds): logs end up in Loki.
    [LoggerMessage(Level = LogLevel.Information, Message = "Participant {ParticipantId} joined room {Room}")]
    private static partial void LogJoined(ILogger logger, string participantId, string room);

    [LoggerMessage(Level = LogLevel.Information, Message = "Participant {ParticipantId} left room {Room}")]
    private static partial void LogLeft(ILogger logger, string participantId, string room);
}
