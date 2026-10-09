using Cipheroom.Api.Hubs.Contracts;
using Cipheroom.Api.Telemetry;
using Cipheroom.Application.Admission.Commands.Admit;
using Cipheroom.Application.Admission.Commands.AskToMute;
using Cipheroom.Application.Admission.Commands.Deny;
using Cipheroom.Application.Admission.Commands.EndCall;
using Cipheroom.Application.Admission.Commands.GrantCoHost;
using Cipheroom.Application.Admission.Commands.JoinLobby;
using Cipheroom.Application.Admission.Commands.Knock;
using Cipheroom.Application.Admission.Commands.RemoveParticipant;
using Cipheroom.Application.Admission.Commands.UpdateSettings;
using Cipheroom.Application.CallStats.Commands.ReportCallStats;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Keys.Commands.SendKeyEnvelopes;
using Cipheroom.Application.Media.Commands.PublishTracks;
using Cipheroom.Application.Media.Commands.Renegotiate;
using Cipheroom.Application.Media.Commands.RestartIce;
using Cipheroom.Application.Media.Commands.SelectVideoLayer;
using Cipheroom.Application.Media.Commands.SetTrackMuted;
using Cipheroom.Application.Media.Commands.SubscribeTracks;
using Cipheroom.Application.Media.Commands.UnpublishTracks;
using Cipheroom.Application.Media.Commands.UnsubscribeTracks;
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
public sealed partial class RoomHub(IMediator mediator, IUsageGuard usage, TelemetryIds ids, ILogger<RoomHub> logger) : Hub<IRoomClient>
{
    /// <summary>Everyone learns the usage guard's level as they connect (before joining anything).</summary>
    public override async Task OnConnectedAsync()
    {
        await Clients.Caller.UsageChanged(UsageDto.From(usage.Current));
        await base.OnConnectedAsync();
    }

    // Lobby and admission. Hosts (host-key proof) and returning members (ticket) join straight in; everyone else
    // waits in the lobby group until an admitter signs a ticket. Names never reach the server (knocks are encrypted).

    public async Task<LobbyResult> JoinLobby(string? roomId, IdentityDto? identity, string?[]? videoCodecs, HostProofDto? hostProof, TicketDto? ticket)
    {
        var result = await mediator.Send(
            new JoinLobbyCommand(
                Context.ConnectionId,
                roomId,
                identity is null ? null : new IdentityInput(identity.Ed25519Pub, identity.X25519Pub, identity.Sig),
                videoCodecs,
                hostProof is null ? null : new HostProofInput(hostProof.HostEd25519Pub, hostProof.HostX25519Pub, hostProof.Attestation),
                ticket is null ? null : new TicketInput(ticket.Issuer, ticket.Sig)),
            Context.ConnectionAborted);
        var room = result.RoomId.Value;
        var authority = AuthorityDto.From(result.Authority);

        if (result.Self is { } self)
        {
            // Authority first: clients verify the newcomer against it.
            if (result.AuthorityChanged)
                await Clients.Groups(GroupName(room), LobbyGroupName(room)).AuthorityUpdated(authority);
            await Groups.AddToGroupAsync(Context.ConnectionId, GroupName(room));
            await Clients.OthersInGroup(GroupName(room)).ParticipantJoined(ParticipantDto.From(self));
            LogJoined(self.Id.Value, room);
            return LobbyResult.Member(self, result.Others, result.Authority);
        }

        await Groups.AddToGroupAsync(Context.ConnectionId, LobbyGroupName(room));
        return new LobbyResult(result.Guest!.Id.Value, false, [], authority, null);
    }

    public async Task Knock(IReadOnlyList<KnockDto?>? knocks)
    {
        var result = await mediator.Send(
            new KnockCommand(Context.ConnectionId, knocks?.Select(k => k is null ? null : new KnockInput(k.ToId, k.Blob)).ToArray()),
            Context.ConnectionAborted);
        var guest = LobbyGuestDto.From(result.Guest);
        await Task.WhenAll(result.Deliveries.Select(d => Clients.Client(d.ConnectionId).KnockReceived(guest, d.Blob)));
    }

    public async Task Admit(string? guestId, string? sig)
    {
        var result = await mediator.Send(new AdmitCommand(Context.ConnectionId, guestId, sig), Context.ConnectionAborted);
        var admitted = result.Admitted;
        var room = admitted.RoomId.Value;

        await Groups.RemoveFromGroupAsync(admitted.ConnectionId, LobbyGroupName(room));
        await Groups.AddToGroupAsync(admitted.ConnectionId, GroupName(room));
        await Clients.GroupExcept(GroupName(room), admitted.ConnectionId).ParticipantJoined(ParticipantDto.From(admitted));
        await NotifyLobbyLeft(result.Authority.Admitters, admitted.Id);
        await Clients.Client(admitted.ConnectionId).Admitted(LobbyResult.Member(admitted, result.Others, result.Authority));
        LogJoined(admitted.Id.Value, room);
    }

    public async Task Deny(string? guestId)
    {
        var result = await mediator.Send(new DenyCommand(Context.ConnectionId, guestId), Context.ConnectionAborted);
        await Groups.RemoveFromGroupAsync(result.Guest.ConnectionId, LobbyGroupName(result.Guest.RoomId.Value));
        await Clients.Client(result.Guest.ConnectionId).Denied();
        await NotifyLobbyLeft(result.Admitters, result.Guest.Id);
    }

    public async Task GrantCoHost(string? participantId, string? sig)
    {
        var result = await mediator.Send(new GrantCoHostCommand(Context.ConnectionId, participantId, sig), Context.ConnectionAborted);
        await AuthorityUpdated(result.RoomId.Value, result.Authority);
    }

    public async Task RemoveParticipant(string? participantId, string? sig)
    {
        var result = await mediator.Send(new RemoveParticipantCommand(Context.ConnectionId, participantId, sig), Context.ConnectionAborted);
        var removed = result.Removed;
        var room = removed.RoomId.Value;

        await Groups.RemoveFromGroupAsync(removed.ConnectionId, GroupName(room));
        await AuthorityUpdated(room, result.Authority);
        await Clients.Group(GroupName(room)).ParticipantLeft(removed.Id.Value);
        await Clients.Client(removed.ConnectionId).Removed();
        LogLeft(removed.Id.Value, room);
    }

    public async Task UpdateSettings(long seq, bool autoAdmit, string? sig)
    {
        var result = await mediator.Send(new UpdateSettingsCommand(Context.ConnectionId, seq, autoAdmit, sig), Context.ConnectionAborted);
        await AuthorityUpdated(result.RoomId.Value, result.Authority);
    }

    public async Task AskToMute(string? participantId, long seq, string? sig)
    {
        var result = await mediator.Send(new AskToMuteCommand(Context.ConnectionId, participantId, seq, sig), Context.ConnectionAborted);
        await Clients.Client(result.TargetConnectionId).MuteRequested(result.FromId.Value, result.Seq, result.Sig);
    }

    public async Task EndCall(string? sig)
    {
        var result = await mediator.Send(new EndCallCommand(Context.ConnectionId, sig), Context.ConnectionAborted);
        var room = result.RoomId.Value;
        await Clients.Groups(GroupName(room), LobbyGroupName(room)).CallEnded(result.Issuer, result.Sig);
        await Task.WhenAll(result.Connections.Select(async c =>
        {
            await Groups.RemoveFromGroupAsync(c, GroupName(room));
            await Groups.RemoveFromGroupAsync(c, LobbyGroupName(room));
        }));
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

    // Telemetry: a browser's call-quality summary (numbers only), recorded as metrics.

    public async Task ReportCallStats(CallStatsDto? stats) =>
        await mediator.Send(new ReportCallStatsCommand(Context.ConnectionId, ToInput(stats)), Context.ConnectionAborted);

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        await LeaveAsync();
        await base.OnDisconnectedAsync(exception);
    }

    private async Task LeaveAsync()
    {
        // Not Context.ConnectionAborted: leaving must complete even while the connection is going away.
        if (await mediator.Send(new LeaveRoomCommand(Context.ConnectionId)) is not { } result)
            return;
        var room = result.RoomId.Value;

        if (result.LeftLobby is { } guest)
        {
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, LobbyGroupName(room));
            await NotifyLobbyLeft(result.Authority.Admitters, guest.Id);
            return;
        }

        var left = result.Left!;
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, GroupName(room));
        await Clients.Group(GroupName(room)).ParticipantLeft(left.Id.Value);
        // One admitter fewer: lobby guests knock on whoever is left.
        if (left.IsAdmitter)
            await AuthorityUpdated(room, result.Authority);
        LogLeft(left.Id.Value, room);
    }

    private Task AuthorityUpdated(string room, RoomAuthority authority) =>
        Clients.Groups(GroupName(room), LobbyGroupName(room)).AuthorityUpdated(AuthorityDto.From(authority));

    private Task NotifyLobbyLeft(IReadOnlyList<Participant> admitters, ParticipantId guestId) =>
        Task.WhenAll(admitters.Select(a => Clients.Client(a.ConnectionId).LobbyLeft(guestId.Value)));

    private void LogJoined(string participantId, string room)
    {
        if (logger.IsEnabled(LogLevel.Information))
        {
            var pseudonym = ids.Room(room);
            LogJoined(logger, participantId, pseudonym);
        }
    }

    private void LogLeft(string participantId, string room)
    {
        if (logger.IsEnabled(LogLevel.Information))
        {
            var pseudonym = ids.Room(room);
            LogLeft(logger, participantId, pseudonym);
        }
    }

    private static CallStatsInput? ToInput(CallStatsDto? s) => s is null
        ? null
        : new CallStatsInput(
            s.Platform,
            s.Path,
            s.IntervalSeconds,
            s.RttMs,
            ToInput(s.AudioSent),
            ToInput(s.AudioReceived),
            ToInput(s.VideoSent),
            ToInput(s.VideoReceived),
            s.E2ee is { } e
                ? new E2eeStatsInput(e.FramesEncrypted, e.FramesDecrypted, e.FramesFailed, e.FramesMissingKey, e.EnvelopesDropped, e.SecuringSeconds)
                : null);

    private static StreamStatsInput? ToInput(StreamStatsDto? s) =>
        s is null ? null : new StreamStatsInput(s.Bytes, s.Packets, s.PacketsLost, s.JitterMs, s.FreezeSeconds, s.Height, s.Fps);

    internal static string GroupName(string roomId) => $"room:{roomId}";

    private static string GroupName(Participant participant) => GroupName(participant.RoomId.Value);

    /// <summary>People waiting to be let in: they hear about admitters and the call ending, nothing else.</summary>
    internal static string LobbyGroupName(string roomId) => $"lobby:{roomId}";

    // Room ids are logged pseudonymously (TelemetryIds): logs end up in Loki.
    [LoggerMessage(Level = LogLevel.Information, Message = "Participant {ParticipantId} joined room {Room}")]
    private static partial void LogJoined(ILogger logger, string participantId, string room);

    [LoggerMessage(Level = LogLevel.Information, Message = "Participant {ParticipantId} left room {Room}")]
    private static partial void LogLeft(ILogger logger, string participantId, string room);
}
