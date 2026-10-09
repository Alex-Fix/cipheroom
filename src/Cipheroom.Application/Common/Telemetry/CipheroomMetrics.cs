using System.Diagnostics;
using System.Diagnostics.Metrics;
using Cipheroom.Application.CallStats.Commands.ReportCallStats;
using Cipheroom.Application.Common.Interfaces;

namespace Cipheroom.Application.Common.Telemetry;

/// <summary>
/// Cipheroom's own metrics (one meter). Labels are low-cardinality only — hub method names, fixed outcomes, SFU
/// operation names — never room or participant ids (those live in traces), so Prometheus stays small and bounded.
/// Prometheus names after the collector: <c>cipheroom_hub_calls_total</c>, <c>cipheroom_sfu_request_duration_seconds</c>, …
/// </summary>
public sealed class CipheroomMetrics
{
    public const string MeterName = "Cipheroom";

    /// <summary>Hub call outcomes: completed, rejected with a client message, or failed unexpectedly.</summary>
    public const string Ok = "ok";
    public const string Rejected = "rejected";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";

    /// <summary>Admission outcomes (no ids): joined straight in (host / reconnect), waiting, admitted, denied, removed, ended.</summary>
    public const string AdmissionJoined = "joined";
    public const string AdmissionWaiting = "waiting";
    public const string AdmissionAdmitted = "admitted";
    public const string AdmissionDenied = "denied";
    public const string AdmissionRemoved = "removed";
    public const string AdmissionEnded = "ended";

    private readonly TimeProvider _time;
    private readonly Counter<long> _hubCalls;
    private readonly Counter<long> _rateLimited;
    private readonly Counter<long> _envelopesRelayed;
    private readonly Counter<long> _admissions;
    private readonly Histogram<double> _sfuDuration;

    // Browser call-quality reports (ReportCallStats).
    private readonly Counter<long> _callReports;
    private readonly Counter<double> _callBytes;
    private readonly Counter<double> _callPackets;
    private readonly Counter<double> _callPacketsLost;
    private readonly Histogram<double> _callJitter;
    private readonly Histogram<double> _callRtt;
    private readonly Counter<double> _callFreeze;
    private readonly Histogram<double> _callHeight;
    private readonly Histogram<double> _callFps;
    private readonly Counter<double> _e2eeFrames;
    private readonly Counter<double> _e2eeEnvelopesDropped;
    private readonly Counter<double> _e2eeSecuring;

    // Cloudflare Realtime free tier (RealtimeUsagePoller).
    private readonly Counter<long> _usagePolls;
    private RealtimeUsage? _usage;
    private long _usagePolledAt;
    private long _freeTierBytes;

    // Usage guard (UsageGuard): its level and the api's own month-to-date estimate.
    private int _usageLevel;
    private double _usageEstimate;

    public CipheroomMetrics(IMeterFactory meterFactory, IRoomStore rooms, TimeProvider time)
    {
        _time = time;
        var meter = meterFactory.Create(MeterName);
        meter.CreateObservableGauge("cipheroom.rooms.active", () => rooms.Stats().Rooms, "{room}", "Rooms with at least one participant.");
        meter.CreateObservableGauge("cipheroom.participants.active", () => rooms.Stats().Participants, "{participant}", "Participants in a room.");
        _hubCalls = meter.CreateCounter<long>("cipheroom.hub.calls", "{call}", "Hub method invocations by method and outcome.");
        _rateLimited = meter.CreateCounter<long>("cipheroom.hub.rate_limited", "{call}", "Hub calls refused by the per-connection rate limit.");
        _envelopesRelayed = meter.CreateCounter<long>("cipheroom.key_envelopes.relayed", "{envelope}", "E2EE key envelopes relayed to recipients.");
        _admissions = meter.CreateCounter<long>("cipheroom.admissions", "{event}", "Lobby and host-control events by outcome.");
        _sfuDuration = meter.CreateHistogram<double>(
            "cipheroom.sfu.request.duration",
            "s",
            "Cloudflare Realtime SFU requests by operation and outcome.",
            advice: new InstrumentAdvice<double> { HistogramBucketBoundaries = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] });

        _callReports = meter.CreateCounter<long>("cipheroom.call.reports", "{report}", "Call-quality reports from browsers.");
        _callBytes = meter.CreateCounter<double>("cipheroom.call.bytes", "By", "Media bytes sent / received, as browsers report them.");
        _callPackets = meter.CreateCounter<double>("cipheroom.call.packets", "{packet}", "RTP packets sent / received.");
        _callPacketsLost = meter.CreateCounter<double>("cipheroom.call.packets_lost", "{packet}", "Received packets lost on the way.");
        _callJitter = meter.CreateHistogram<double>(
            "cipheroom.call.jitter", "s", "Receive jitter per report.",
            advice: new InstrumentAdvice<double> { HistogramBucketBoundaries = [0.005, 0.01, 0.02, 0.03, 0.05, 0.1, 0.2, 0.5] });
        _callRtt = meter.CreateHistogram<double>(
            "cipheroom.call.rtt", "s", "Round trip to Cloudflare per report.",
            advice: new InstrumentAdvice<double> { HistogramBucketBoundaries = [0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1] });
        _callFreeze = meter.CreateCounter<double>("cipheroom.call.freeze.duration", "s", "Time received video was frozen.");
        _callHeight = meter.CreateHistogram<double>(
            "cipheroom.call.video.height", "{px}", "Video height per report (received: tallest stream).",
            advice: new InstrumentAdvice<double> { HistogramBucketBoundaries = [180, 360, 540, 720, 1080, 1440, 2160] });
        _callFps = meter.CreateHistogram<double>(
            "cipheroom.call.video.fps", "{frame}/s", "Video frame rate per report.",
            advice: new InstrumentAdvice<double> { HistogramBucketBoundaries = [5, 10, 15, 20, 25, 30, 50, 60] });
        _e2eeFrames = meter.CreateCounter<double>("cipheroom.e2ee.frames", "{frame}", "Frames through the E2EE worker by result.");
        _e2eeEnvelopesDropped = meter.CreateCounter<double>("cipheroom.e2ee.envelopes_dropped", "{envelope}", "Key envelopes browsers rejected.");
        _e2eeSecuring = meter.CreateCounter<double>("cipheroom.e2ee.securing.duration", "s", "Time spent waiting for someone's key ('Securing…').");

        meter.CreateObservableGauge(
            "cipheroom.realtime.egress",
            () => _usage is { } u
                ? [new Measurement<long>(u.SfuEgressBytes, new KeyValuePair<string, object?>("service", "sfu")),
                   new Measurement<long>(u.TurnEgressBytes, new KeyValuePair<string, object?>("service", "turn"))]
                : Array.Empty<Measurement<long>>(),
            "By",
            "Cloudflare Realtime egress this calendar month (UTC), from Cloudflare's analytics.");
        meter.CreateObservableGauge(
            "cipheroom.realtime.free_tier",
            () => _freeTierBytes > 0 ? [new Measurement<long>(_freeTierBytes)] : Array.Empty<Measurement<long>>(),
            "By",
            "Free Realtime egress per month (SFU and TURN combined).");
        meter.CreateObservableGauge(
            "cipheroom.realtime.polled",
            () => _usagePolledAt > 0 ? [new Measurement<long>(_usagePolledAt)] : Array.Empty<Measurement<long>>(),
            "s",
            "When usage was last read from Cloudflare (Unix time).");
        _usagePolls = meter.CreateCounter<long>("cipheroom.realtime.polls", "{poll}", "Usage polls by outcome.");
        meter.CreateObservableGauge("cipheroom.usage_guard.level", () => _usageLevel, "{level}", "Usage guard level: 0 normal, 1 saving, 2 audio-only, 3 paused.");
        meter.CreateObservableGauge("cipheroom.usage.estimate", () => _usageEstimate, "By", "This month's Realtime egress as estimated from browser reports.");
    }

    public void SetRealtimeFreeTier(long bytes) => _freeTierBytes = bytes;

    public void RealtimeUsagePolled(RealtimeUsage usage, DateTimeOffset at)
    {
        _usage = usage;
        _usagePolledAt = at.ToUnixTimeSeconds();
        _usagePolls.Add(1, new KeyValuePair<string, object?>("outcome", Ok));
    }

    public void UsageGuardUpdated(int level, double estimateBytes)
    {
        _usageLevel = level;
        _usageEstimate = estimateBytes;
    }

    public void RealtimeUsagePollFailed() => _usagePolls.Add(1, new KeyValuePair<string, object?>("outcome", Failed));

    public void HubCall(string method, string outcome) =>
        _hubCalls.Add(1, new("method", method), new("outcome", outcome));

    public void RateLimited(string method) => _rateLimited.Add(1, new KeyValuePair<string, object?>("method", method));

    public void EnvelopesRelayed(int count) => _envelopesRelayed.Add(count);

    public void Admission(string outcome) => _admissions.Add(1, new KeyValuePair<string, object?>("outcome", outcome));

    /// <summary>
    /// Records one browser report. Labels: the (validated) platform and path, kind and direction — nothing that
    /// identifies a person or a room.
    /// </summary>
    public void CallReport(CallStatsInput stats, string platform, string path)
    {
        _callReports.Add(1, new KeyValuePair<string, object?>("platform", platform));
        if (stats.RttMs is { } rtt)
            _callRtt.Record(rtt / 1000, new("platform", platform), new("path", path));
        Stream(stats.AudioSent, "audio", "sent", platform, path);
        Stream(stats.AudioReceived, "audio", "received", platform, path);
        Stream(stats.VideoSent, "video", "sent", platform, path);
        Stream(stats.VideoReceived, "video", "received", platform, path);

        if (stats.E2ee is { } e)
        {
            _e2eeFrames.Add(e.FramesEncrypted, new KeyValuePair<string, object?>("result", "encrypted"));
            _e2eeFrames.Add(e.FramesDecrypted, new KeyValuePair<string, object?>("result", "decrypted"));
            _e2eeFrames.Add(e.FramesFailed, new KeyValuePair<string, object?>("result", "failed"));
            _e2eeFrames.Add(e.FramesMissingKey, new KeyValuePair<string, object?>("result", "missing_key"));
            _e2eeEnvelopesDropped.Add(e.EnvelopesDropped);
            _e2eeSecuring.Add(e.SecuringSeconds, new KeyValuePair<string, object?>("platform", platform));
        }
    }

    private void Stream(StreamStatsInput? s, string kind, string direction, string platform, string path)
    {
        if (s is null)
            return;
        TagList tags = new() { { "kind", kind }, { "direction", direction }, { "platform", platform }, { "path", path } };
        _callBytes.Add(s.Bytes, tags);
        _callPackets.Add(s.Packets, tags);
        if (direction != "received")
            return;

        TagList received = new() { { "kind", kind }, { "platform", platform }, { "path", path } };
        _callPacketsLost.Add(s.PacketsLost, received);
        if (s.JitterMs is { } jitter)
            _callJitter.Record(jitter / 1000, received);
        if (kind != "video")
            return;

        TagList video = new() { { "platform", platform } };
        if (s.FreezeSeconds is { } freeze)
            _callFreeze.Add(freeze, video);
        if (s.Height is { } height)
            _callHeight.Record(height, video);
        if (s.Fps is { } fps)
            _callFps.Record(fps, video);
    }

    /// <summary>Times one media-server request: ok, failed (any error) or cancelled (the caller went away).</summary>
    public async Task<T> MeasureSfuAsync<T>(string operation, Func<Task<T>> request, CancellationToken cancellationToken)
    {
        var start = _time.GetTimestamp();
        var outcome = Failed;
        try
        {
            var result = await request();
            outcome = Ok;
            return result;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            outcome = Cancelled;
            throw;
        }
        finally
        {
            _sfuDuration.Record(_time.GetElapsedTime(start).TotalSeconds, new("operation", operation), new("outcome", outcome));
        }
    }
}
