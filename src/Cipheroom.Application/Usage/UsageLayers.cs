using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Application.Usage;

/// <summary>Simulcast layers the usage guard holds received cameras at.</summary>
internal static class UsageLayers
{
    public const string Half = "h";

    /// <summary>Best effort: a camera the SFU can't switch yet keeps flowing, and the client's next layer choice is capped.</summary>
    public static async Task HoldAtHalfAsync(ISfu sfu, string subscriberSession, string mid, RemoteTrack track, CancellationToken cancellationToken)
    {
        try
        {
            await sfu.SelectLayerAsync(subscriberSession, mid, new SfuRemoteTrack(track.PublisherSfuSessionId, track.Track.Name, Simulcast: true), Half, cancellationToken);
        }
        catch (MediaServerException)
        {
            // The subscriber's own layer requests are rewritten to the half layer anyway.
        }
    }
}
