using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Common.Telemetry;

namespace Cipheroom.Infrastructure.Rtc.Cloudflare;

/// <summary>
/// <see cref="ISfu"/> on Cloudflare Realtime SFU. Adapter only: HTTP lives in <see cref="CloudflareSfuClient"/>.
/// Every failure (HTTP, Cloudflare error code, per-track error, timeout) becomes a <see cref="MediaServerException"/>.
/// Every request is timed by operation (<see cref="CipheroomMetrics"/>). Offers the client must answer are remembered
/// as codec summaries (<see cref="PendingOffers"/>), so a refused answer is logged with what was offered and answered.
/// </summary>
public sealed class CloudflareSfu(CloudflareSfuClient cloudflare, CipheroomMetrics metrics, PendingOffers pendingOffers) : ISfu
{
    // Highest quality first; Cloudflare steps down (asciibetical: f → h → q) when the receiver can't keep up.
    private const string FirstLayer = "f";

    // The only channel the establish call may pull: the SFU's own events channel.
    private const string ServerEventsChannel = "server-events";

    public Task<string> CreateSessionAsync(CancellationToken cancellationToken) =>
        Call("create_session", async () => (await cloudflare.NewSessionAsync(cancellationToken)).SessionId, cancellationToken);

    public Task<string> PublishAsync(string sessionId, string offerSdp, IReadOnlyList<SfuLocalTrack> tracks, CancellationToken cancellationToken) =>
        Call("publish", async () =>
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
        Call("subscribe", async () =>
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
            var offer = response.RequiresImmediateRenegotiation ? Sdp(response.SessionDescription) : null;
            if (offer is not null)
                pendingOffers.Remember(sessionId, offer);
            return new SfuSubscribeResult(offer, pulled);
        }, cancellationToken);

    public async Task RenegotiateAsync(string sessionId, string answerSdp, CancellationToken cancellationToken)
    {
        try
        {
            await Call("renegotiate", () => cloudflare.RenegotiateAsync(sessionId, new RenegotiateRequest(new SessionDescription("answer", answerSdp)), cancellationToken), cancellationToken);
            pendingOffers.Take(sessionId);
        }
        catch (MediaServerException ex) when (ex.InnerException is CloudflareSfuException refused)
        {
            // Codec names only: which codec a subscriber left out is what a refused answer usually comes down to.
            throw new MediaServerException(new SfuAnswerRefusedException(pendingOffers.Take(sessionId), SdpCodecs.Summary(answerSdp), refused));
        }
    }

    public Task<string> RestartIceAsync(string sessionId, string offerSdp, CancellationToken cancellationToken) =>
        Call("restart_ice", async () =>
        {
            var response = await cloudflare.RenegotiateAsync(sessionId, new RenegotiateRequest(new SessionDescription("offer", offerSdp)), cancellationToken);
            return Sdp(response.SessionDescription);
        }, cancellationToken);

    public Task CloseTracksAsync(string sessionId, IReadOnlyList<string> mids, CancellationToken cancellationToken) =>
        // Forced: no SDP exchange. Per-track errors mean "already closed / absent" — fine for a close.
        Call("close_tracks", () => cloudflare.CloseTracksAsync(sessionId, new CloseTracksRequest([.. mids.Select(m => new SfuTrack(Mid: m))], Force: true), cancellationToken), cancellationToken);

    public Task SelectLayerAsync(string sessionId, string mid, SfuRemoteTrack track, string rid, CancellationToken cancellationToken) =>
        Call("select_layer", async () =>
        {
            var response = await cloudflare.UpdateTracksAsync(sessionId, new TracksRequest([Remote(track, rid) with { Mid = mid }]), cancellationToken);
            EnsureNoTrackErrors(response.Tracks);
            return response;
        }, cancellationToken);

    public Task<SfuDataTransport> EstablishDataTransportAsync(string sessionId, CancellationToken cancellationToken) =>
        Call("establish_data_transport", async () =>
        {
            // "Ask for an offer": the SFU adds the application section, like a subscribe, so the browser only ever
            // answers — no new local offer after receiving started (negotiation-order rule).
            var response = await cloudflare.EstablishDataTransportAsync(
                sessionId,
                new EstablishDataTransportRequest(new SfuDataChannel(Location: "remote", DataChannelName: ServerEventsChannel)),
                cancellationToken);
            var id = response.DataChannel is { ErrorCode: null, Id: { } channelId } ? channelId : throw new MediaServerException();
            var offer = Sdp(response.SessionDescription);
            pendingOffers.Remember(sessionId, offer);
            return new SfuDataTransport(offer, id);
        }, cancellationToken);

    public Task<int> PublishDataChannelAsync(string sessionId, string name, CancellationToken cancellationToken) =>
        Call("publish_data_channel", async () => ChannelId(await cloudflare.NewDataChannelsAsync(
            sessionId,
            new DataChannelsRequest([new SfuDataChannel(Location: "local", DataChannelName: name)]),
            cancellationToken)), cancellationToken);

    public Task<int> SubscribeDataChannelAsync(string sessionId, string publisherSessionId, string name, CancellationToken cancellationToken) =>
        Call("subscribe_data_channel", async () => ChannelId(await cloudflare.NewDataChannelsAsync(
            sessionId,
            new DataChannelsRequest([new SfuDataChannel(Location: "remote", SessionId: publisherSessionId, DataChannelName: name)]),
            cancellationToken)), cancellationToken);

    public Task CloseDataChannelsAsync(string sessionId, IReadOnlyList<int> ids, CancellationToken cancellationToken) =>
        // Per-channel errors mean "already closed / absent" — fine for a close.
        Call("close_data_channels", () => cloudflare.CloseDataChannelsAsync(
            sessionId,
            new DataChannelsRequest([.. ids.Select(id => new SfuDataChannel(Id: id))]),
            cancellationToken), cancellationToken);

    private static int ChannelId(DataChannelsResponse response) =>
        response.DataChannels is [{ ErrorCode: null, Id: { } id }]
            ? id
            : throw new MediaServerException(new CloudflareSfuException(200, response.DataChannels is [var first, ..] ? first.ErrorCode : null));

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

    private async Task<T> Call<T>(string operation, Func<Task<T>> call, CancellationToken cancellationToken)
    {
        try
        {
            return await metrics.MeasureSfuAsync(operation, call, cancellationToken);
        }
        catch (Exception ex) when (ex is CloudflareSfuException or HttpRequestException
            || (ex is OperationCanceledException && !cancellationToken.IsCancellationRequested))
        {
            // Includes resilience-handler timeouts; a cancelled caller (client went away) propagates as is.
            throw new MediaServerException(ex);
        }
    }
}
