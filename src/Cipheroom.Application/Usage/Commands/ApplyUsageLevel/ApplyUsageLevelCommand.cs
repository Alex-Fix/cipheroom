using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;
using Mediator;

namespace Cipheroom.Application.Usage.Commands.ApplyUsageLevel;

/// <summary>
/// The usage guard reached a new level: apply it to the calls in progress, server-side (clients are untrusted).
/// Saving: every received camera to the half layer. Audio-only: stop forwarding all video. Paused: stop forwarding
/// everything and empty every room and lobby. Sent by the server itself, never by a client.
/// </summary>
public sealed record ApplyUsageLevelCommand(UsageLevel Level) : ICommand<ApplyUsageLevelResult>;

/// <param name="Ended">Connections taken out of their room or lobby (paused), so the hub can drop their groups.</param>
public sealed record ApplyUsageLevelResult(IReadOnlyList<EndedConnection> Ended);

public sealed record EndedConnection(string ConnectionId, RoomId RoomId);

public sealed class ApplyUsageLevelCommandHandler(IRoomStore rooms, ISfu sfu) : ICommandHandler<ApplyUsageLevelCommand, ApplyUsageLevelResult>
{
    public async ValueTask<ApplyUsageLevelResult> Handle(ApplyUsageLevelCommand command, CancellationToken cancellationToken)
    {
        switch (command.Level)
        {
            case UsageLevel.Saving:
                await HoldCamerasAtHalfAsync(cancellationToken);
                return new ApplyUsageLevelResult([]);
            case UsageLevel.AudioOnly:
                await CloseAsync(rooms.AcrossRooms(room => Unsubscribe(room, s => s.Source != TrackSource.Microphone)), cancellationToken);
                return new ApplyUsageLevelResult([]);
            case UsageLevel.Paused:
                await CloseAsync(rooms.AcrossRooms(room => Unsubscribe(room, _ => true)), cancellationToken);
                return new ApplyUsageLevelResult(rooms.AcrossRooms(room => room.Clear().Select(c => new EndedConnection(c, room.Id))));
            default:
                return new ApplyUsageLevelResult([]);
        }
    }

    private async Task HoldCamerasAtHalfAsync(CancellationToken cancellationToken)
    {
        var cameras = rooms.AcrossRooms(room => room.Participants
            .Where(p => p.SfuSessionId is not null)
            .SelectMany(p => p.Subscriptions
                .Where(s => s.Source == TrackSource.Camera)
                .Select(s => (Session: p.SfuSessionId!, s.Mid, Track: Resolve(room, p.Id, s.Mid))))
            .Where(c => c.Track is not null)
            .ToArray());
        foreach (var (session, mid, track) in cameras)
            await UsageLayers.HoldAtHalfAsync(sfu, session, mid, track!, cancellationToken);
    }

    private static RemoteTrack? Resolve(Room room, ParticipantId subscriber, string mid)
    {
        try
        {
            return room.FindSubscription(subscriber, mid);
        }
        catch (Domain.Common.DomainException)
        {
            return null;
        }
    }

    /// <summary>Drops matching subscriptions from room state; returns, per session, the mids to close at the SFU.</summary>
    private static (string Session, string[] Mids)[] Unsubscribe(Room room, Func<Subscription, bool> match) =>
        // A snapshot: unsubscribing replaces participants in the room's list.
        room.Participants.ToArray()
            .Where(p => p.SfuSessionId is not null)
            .Select(p => (Session: p.SfuSessionId!, Mids: room.Unsubscribe(p.Id, [.. p.Subscriptions.Where(match).Select(s => s.Mid)]).Select(s => s.Mid).ToArray()))
            .Where(x => x.Mids.Length > 0)
            .ToArray();

    private async Task CloseAsync(IReadOnlyList<(string Session, string[] Mids)> closing, CancellationToken cancellationToken)
    {
        foreach (var (session, mids) in closing)
        {
            try
            {
                await sfu.CloseTracksAsync(session, mids, cancellationToken);
            }
            catch (MediaServerException)
            {
                // Best effort: room state no longer lists them, so nothing re-subscribes; the session expires on its own.
            }
        }
    }
}
