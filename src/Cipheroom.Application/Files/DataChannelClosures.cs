using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Application.Files;

internal static class DataChannelClosures
{
    /// <summary>
    /// Closes channels on the media server, one request per session. Best effort: the room state already forgot them,
    /// and a session that went away took its channels with it.
    /// </summary>
    public static async Task CloseAsync(ISfu sfu, IReadOnlyList<DataChannelClosure> closures, CancellationToken cancellationToken)
    {
        foreach (var session in closures.GroupBy(c => c.SfuSessionId))
        {
            try
            {
                await sfu.CloseDataChannelsAsync(session.Key, [.. session.Select(c => c.Id)], cancellationToken);
            }
            catch (MediaServerException)
            {
                // Already gone on the SFU.
            }
        }
    }
}
