using Cipheroom.Application.Common.Telemetry;
using Microsoft.Extensions.Diagnostics.Metrics.Testing;
using Microsoft.Extensions.Time.Testing;

namespace Cipheroom.Application.UnitTests.Common;

public sealed class CipheroomMetricsTests
{
    private readonly FakeRoomStore _rooms = new();
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    [Fact]
    public void Active_rooms_and_participants_come_from_the_room_store()
    {
        var (_, factory) = TestMetrics.Create(_rooms);
        using var rooms = new MetricCollector<int>(factory, CipheroomMetrics.MeterName, "cipheroom.rooms.active");
        using var participants = new MetricCollector<int>(factory, CipheroomMetrics.MeterName, "cipheroom.participants.active");
        _rooms.Join("a", "room-1");
        _rooms.Join("b", "room-1");
        _rooms.Join("c", "room-2");

        rooms.RecordObservableInstruments();
        participants.RecordObservableInstruments();

        Assert.Equal(2, rooms.LastMeasurement?.Value);
        Assert.Equal(3, participants.LastMeasurement?.Value);
    }

    [Fact]
    public void Hub_calls_are_counted_by_method_and_outcome_only()
    {
        var (metrics, factory) = TestMetrics.Create(_rooms);
        using var calls = new MetricCollector<long>(factory, CipheroomMetrics.MeterName, "cipheroom.hub.calls");

        metrics.HubCall("JoinRoom", CipheroomMetrics.Ok);
        metrics.HubCall("JoinRoom", CipheroomMetrics.Rejected);

        Assert.Equal(2, calls.GetMeasurementSnapshot().Count);
        var last = calls.LastMeasurement!;
        Assert.Equal(["method", "outcome"], last.Tags.Keys.Order());
        Assert.Equal("rejected", last.Tags["outcome"]);
    }

    [Fact]
    public void Relayed_chat_events_are_counted()
    {
        var (metrics, factory) = TestMetrics.Create(_rooms);
        using var chat = new MetricCollector<long>(factory, CipheroomMetrics.MeterName, "cipheroom.chat.relayed");

        metrics.ChatRelayed();
        metrics.ChatRelayed();

        Assert.Equal(2, chat.GetMeasurementSnapshot().Sum(m => m.Value));
        Assert.Empty(chat.LastMeasurement!.Tags);
    }

    [Fact]
    public void Rate_limits_and_relayed_envelopes_are_counted()
    {
        var (metrics, factory) = TestMetrics.Create(_rooms);
        using var limited = new MetricCollector<long>(factory, CipheroomMetrics.MeterName, "cipheroom.hub.rate_limited");
        using var envelopes = new MetricCollector<long>(factory, CipheroomMetrics.MeterName, "cipheroom.key_envelopes.relayed");

        metrics.RateLimited("SendKeyEnvelopes");
        metrics.EnvelopesRelayed(3);

        Assert.Equal("SendKeyEnvelopes", limited.LastMeasurement?.Tags["method"]);
        Assert.Equal(3, envelopes.LastMeasurement?.Value);
    }

    [Fact]
    public async Task Sfu_requests_are_timed_by_operation_and_outcome()
    {
        var time = new FakeTimeProvider();
        var (metrics, factory) = TestMetrics.Create(_rooms, time);
        using var durations = new MetricCollector<double>(factory, CipheroomMetrics.MeterName, "cipheroom.sfu.request.duration");

        await metrics.MeasureSfuAsync("publish", async () =>
        {
            time.Advance(TimeSpan.FromMilliseconds(250));
            await Task.Yield();
            return "answer";
        }, _ct);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            metrics.MeasureSfuAsync<string>("subscribe", () => throw new InvalidOperationException(), _ct));

        var measurements = durations.GetMeasurementSnapshot();
        Assert.Equal(0.25, measurements[0].Value, 3);
        Assert.Equal(("publish", "ok"), ((string)measurements[0].Tags["operation"]!, (string)measurements[0].Tags["outcome"]!));
        Assert.Equal("failed", measurements[1].Tags["outcome"]);
    }

    [Fact]
    public async Task A_cancelled_caller_is_not_a_failure()
    {
        var (metrics, factory) = TestMetrics.Create(_rooms);
        using var durations = new MetricCollector<double>(factory, CipheroomMetrics.MeterName, "cipheroom.sfu.request.duration");
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(() =>
            metrics.MeasureSfuAsync<string>("publish", () => throw new OperationCanceledException(cts.Token), cts.Token));

        Assert.Equal("cancelled", durations.LastMeasurement?.Tags["outcome"]);
    }
}
