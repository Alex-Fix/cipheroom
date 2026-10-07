using System.Diagnostics.Metrics;
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

    private readonly TimeProvider _time;
    private readonly Counter<long> _hubCalls;
    private readonly Counter<long> _rateLimited;
    private readonly Counter<long> _envelopesRelayed;
    private readonly Histogram<double> _sfuDuration;

    public CipheroomMetrics(IMeterFactory meterFactory, IRoomStore rooms, TimeProvider time)
    {
        _time = time;
        var meter = meterFactory.Create(MeterName);
        meter.CreateObservableGauge("cipheroom.rooms.active", () => rooms.Stats().Rooms, "{room}", "Rooms with at least one participant.");
        meter.CreateObservableGauge("cipheroom.participants.active", () => rooms.Stats().Participants, "{participant}", "Participants in a room.");
        _hubCalls = meter.CreateCounter<long>("cipheroom.hub.calls", "{call}", "Hub method invocations by method and outcome.");
        _rateLimited = meter.CreateCounter<long>("cipheroom.hub.rate_limited", "{call}", "Hub calls refused by the per-connection rate limit.");
        _envelopesRelayed = meter.CreateCounter<long>("cipheroom.key_envelopes.relayed", "{envelope}", "E2EE key envelopes relayed to recipients.");
        _sfuDuration = meter.CreateHistogram<double>(
            "cipheroom.sfu.request.duration",
            "s",
            "Cloudflare Realtime SFU requests by operation and outcome.",
            advice: new InstrumentAdvice<double> { HistogramBucketBoundaries = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] });
    }

    public void HubCall(string method, string outcome) =>
        _hubCalls.Add(1, new("method", method), new("outcome", outcome));

    public void RateLimited(string method) => _rateLimited.Add(1, new KeyValuePair<string, object?>("method", method));

    public void EnvelopesRelayed(int count) => _envelopesRelayed.Add(count);

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
