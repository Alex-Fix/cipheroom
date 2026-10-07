using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Infrastructure.Rtc.Cloudflare;

namespace Cipheroom.Infrastructure.Rtc;

/// <summary>
/// <see cref="ISfu"/> on Cloudflare Realtime SFU. Adapter only: HTTP lives in <see cref="CloudflareSfuClient"/>.
/// Every failure (HTTP, Cloudflare error code, per-track error, timeout) becomes a <see cref="MediaServerException"/>.
/// </summary>
public sealed class CloudflareSfu(CloudflareSfuClient cloudflare) : ISfu
{
    // Highest quality first; Cloudflare steps down (asciibetical: f → h → q) when the receiver can't keep up.
    private const string FirstLayer = "f";

    public Task<string> CreateSessionAsync(CancellationToken cancellationToken) =>
        Call(async () => (await cloudflare.NewSessionAsync(cancellationToken)).SessionId, cancellationToken);

    public Task<string> PublishAsync(string sessionId, string offerSdp, IReadOnlyList<SfuLocalTrack> tracks, CancellationToken cancellationToken) =>
        Call(async () =>
        {
            var response = await cloudflare.NewTracksAsync(
                sessionId,
                new TracksRequest(
                    [.. tracks.Select(t => new SfuTrack(Location: "local", Mid: t.Mid, TrackName: t.TrackName))],
                    new SessionDescription("offer", offerSdp)),
                cancellationToken);
            EnsureNoTrackErrors(response.Tracks);
            return Sdp(response.SessionDescription);
        }, cancellationToken);

    public Task<SfuSubscribeResult> SubscribeAsync(string sessionId, IReadOnlyList<SfuRemoteTrack> tracks, CancellationToken cancellationToken) =>
        Call(async () =>
        {
            var response = await cloudflare.NewTracksAsync(
                sessionId,
                new TracksRequest([.. tracks.Select(t => Remote(t, t.Simulcast ? FirstLayer : null))]),
                cancellationToken);

            // Per-track errors (e.g. empty_track_error: the publisher's media hasn't arrived yet, or they just left)
            // must not fail the batch: Cloudflare has already added the other tracks and expects an answer to its
            // offer — an unanswered offer breaks the session's next negotiation. Failed tracks are simply left out;
            // the client retries them. Track names are unique (they embed the participant id), so they identify each
            // result.
            SfuPulledTrack[] pulled =
            [
                .. (response.Tracks ?? []).Where(r => r.ErrorCode is null && r.Mid is not null).Join(
                    tracks,
                    r => r.TrackName,
                    t => t.TrackName,
                    (r, t) => new SfuPulledTrack(t.PublisherSessionId, t.TrackName, r.Mid!)),
            ];
            return new SfuSubscribeResult(response.RequiresImmediateRenegotiation ? Sdp(response.SessionDescription) : null, pulled);
        }, cancellationToken);

    public Task RenegotiateAsync(string sessionId, string answerSdp, CancellationToken cancellationToken) =>
        Call(() => cloudflare.RenegotiateAsync(sessionId, new RenegotiateRequest(new SessionDescription("answer", answerSdp)), cancellationToken), cancellationToken);

    public Task<string> RestartIceAsync(string sessionId, string offerSdp, CancellationToken cancellationToken) =>
        Call(async () =>
        {
            var response = await cloudflare.RenegotiateAsync(sessionId, new RenegotiateRequest(new SessionDescription("offer", offerSdp)), cancellationToken);
            return Sdp(response.SessionDescription);
        }, cancellationToken);

    public Task CloseTracksAsync(string sessionId, IReadOnlyList<string> mids, CancellationToken cancellationToken) =>
        // Forced: no SDP exchange. Per-track errors mean "already closed / absent" — fine for a close.
        Call(() => cloudflare.CloseTracksAsync(sessionId, new CloseTracksRequest([.. mids.Select(m => new SfuTrack(Mid: m))], Force: true), cancellationToken), cancellationToken);

    public Task SelectLayerAsync(string sessionId, string mid, SfuRemoteTrack track, string rid, CancellationToken cancellationToken) =>
        Call(async () =>
        {
            var response = await cloudflare.UpdateTracksAsync(sessionId, new TracksRequest([Remote(track, rid) with { Mid = mid }]), cancellationToken);
            EnsureNoTrackErrors(response.Tracks);
            return response;
        }, cancellationToken);

    private static SfuTrack Remote(SfuRemoteTrack track, string? preferredRid) => new(
        Location: "remote",
        SessionId: track.PublisherSessionId,
        TrackName: track.TrackName,
        Simulcast: preferredRid is null ? null : new SimulcastPreference(preferredRid));

    private static string Sdp(SessionDescription? description) =>
        description?.Sdp is { Length: > 0 } sdp ? sdp : throw new MediaServerException();

    private static void EnsureNoTrackErrors(IReadOnlyList<SfuTrack>? tracks)
    {
        if (tracks?.FirstOrDefault(t => t.ErrorCode is not null) is { } failed)
            throw new MediaServerException(new CloudflareSfuException(200, failed.ErrorCode));
    }

    private static async Task<T> Call<T>(Func<Task<T>> call, CancellationToken cancellationToken)
    {
        try
        {
            return await call();
        }
        catch (Exception ex) when (ex is CloudflareSfuException or HttpRequestException
            || (ex is OperationCanceledException && !cancellationToken.IsCancellationRequested))
        {
            // Includes resilience-handler timeouts; a cancelled caller (client went away) propagates as is.
            throw new MediaServerException(ex);
        }
    }
}
