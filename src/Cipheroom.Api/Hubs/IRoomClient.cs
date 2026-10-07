using Cipheroom.Api.Hubs.Contracts;

namespace Cipheroom.Api.Hubs;

/// <summary>Server → client events. Mirrored in web/src/app/core/signaling/signaling.types.ts.</summary>
public interface IRoomClient
{
    Task ParticipantJoined(ParticipantDto participant);

    Task ParticipantLeft(string participantId);

    Task TracksPublished(string participantId, IReadOnlyList<TrackDto> tracks);

    /// <param name="sources">microphone / camera / screen.</param>
    Task TracksUnpublished(string participantId, IReadOnlyList<string> sources);

    Task TrackMuted(string participantId, string source, bool muted);
}
