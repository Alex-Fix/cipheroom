using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Infrastructure.Rtc;

/// <summary>
/// <see cref="IMediaRoom"/> on Cloudflare Realtime SFU: closes a removed participant's tracks on their session. An
/// ended call needs nothing here — everyone's browser leaves and Cloudflare expires the sessions.
/// </summary>
public sealed class CloudflareMediaRoom(ISfu sfu) : IMediaRoom
{
    public MediaProvider Provider => MediaProvider.Cloudflare;

    public async Task RemoveParticipantAsync(RoomId room, Participant removed, CancellationToken cancellationToken)
    {
        string[] mids = [.. removed.Subscriptions.Select(s => s.Mid), .. removed.Tracks.Select(t => t.Mid)];
        if (removed.SfuSessionId is { } session && mids.Length > 0)
            await sfu.CloseTracksAsync(session, [.. mids.Distinct()], cancellationToken);
    }

    public Task EndRoomAsync(RoomId room, CancellationToken cancellationToken) => Task.CompletedTask;
}
