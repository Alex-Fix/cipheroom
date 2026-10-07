namespace Cipheroom.Application.Common.Interfaces;

/// <summary>
/// Media server (SFU) operations. Each participant has one session (one browser peer connection). Mutations on one
/// session must not overlap — clients serialize them. Failures surface as
/// <see cref="Exceptions.MediaServerException"/>. SDP passes through untouched and must never be logged.
/// </summary>
public interface ISfu
{
    Task<string> CreateSessionAsync(CancellationToken cancellationToken);

    /// <summary>Publishes the offered local tracks under server-chosen names. Returns the SFU's SDP answer.</summary>
    Task<string> PublishAsync(string sessionId, string offerSdp, IReadOnlyList<SfuLocalTrack> tracks, CancellationToken cancellationToken);

    /// <summary>Starts forwarding other sessions' tracks to this one. The SFU answers with an offer when the client
    /// must renegotiate (<see cref="RenegotiateAsync"/>).</summary>
    Task<SfuSubscribeResult> SubscribeAsync(string sessionId, IReadOnlyList<SfuRemoteTrack> tracks, CancellationToken cancellationToken);

    /// <summary>Completes an SFU-initiated negotiation with the client's answer.</summary>
    Task RenegotiateAsync(string sessionId, string answerSdp, CancellationToken cancellationToken);

    /// <summary>Client-initiated renegotiation (ICE restart). Returns the SFU's SDP answer.</summary>
    Task<string> RestartIceAsync(string sessionId, string offerSdp, CancellationToken cancellationToken);

    /// <summary>Stops tracks on this session by transceiver mid, without an SDP exchange.</summary>
    Task CloseTracksAsync(string sessionId, IReadOnlyList<string> mids, CancellationToken cancellationToken);

    /// <summary>Chooses the simulcast layer (<c>f</c>/<c>h</c>/<c>q</c>) forwarded on a received track.</summary>
    Task SelectLayerAsync(string sessionId, string mid, SfuRemoteTrack track, string rid, CancellationToken cancellationToken);
}

public sealed record SfuLocalTrack(string Mid, string TrackName);

/// <param name="Simulcast">Publisher sends f/h/q layers; the SFU starts with the full layer (<c>f</c>) and steps down on congestion.</param>
public sealed record SfuRemoteTrack(string PublisherSessionId, string TrackName, bool Simulcast);

public sealed record SfuPulledTrack(string PublisherSessionId, string TrackName, string Mid);

/// <param name="OfferSdp">Null when no renegotiation is needed.</param>
public sealed record SfuSubscribeResult(string? OfferSdp, IReadOnlyList<SfuPulledTrack> Tracks);
