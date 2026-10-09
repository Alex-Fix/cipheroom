using Cipheroom.Application.CallStats;
using Cipheroom.Application.CallStats.Commands.ReportCallStats;
using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Telemetry;
using Cipheroom.Application.UnitTests.Common;
using Microsoft.Extensions.Diagnostics.Metrics.Testing;

namespace Cipheroom.Application.UnitTests.CallStats;

public sealed class ReportCallStatsCommandTests
{
    private readonly FakeUsageGuard _usage = new();
    private readonly FakeRoomStore _rooms = new();
    private readonly ReportCallStatsCommandValidator _validator = new();
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    private static readonly StreamStatsInput Received = new(Bytes: 2_000_000, Packets: 2000, PacketsLost: 20, JitterMs: 12, FreezeSeconds: 0.5, Height: 1080, Fps: 30);
    private static readonly StreamStatsInput Sent = new(Bytes: 1_500_000, Packets: 1500, PacketsLost: 0, JitterMs: null, FreezeSeconds: null, Height: 720, Fps: 30);
    private static readonly E2eeStatsInput E2ee = new(FramesEncrypted: 900, FramesDecrypted: 1800, FramesFailed: 2, FramesMissingKey: 30, EnvelopesDropped: 1, SecuringSeconds: 1.5);

    private static CallStatsInput Report(string platform = "ios-safari", string path = "direct") =>
        new(platform, path, IntervalSeconds: 15, RttMs: 42, Sent, Received, Sent, Received, E2ee);

    [Fact]
    public void A_full_report_is_valid() =>
        Assert.True(_validator.Validate(new ReportCallStatsCommand("conn", Report())).IsValid);

    [Fact]
    public void Optional_parts_may_be_missing() =>
        Assert.True(_validator.Validate(new ReportCallStatsCommand("conn",
            new CallStatsInput("other", "unknown", 15, null, null, null, null, null, null))).IsValid);

    public static TheoryData<string> Invalid => new()
    {
        "no stats", "empty platform", "long platform", "zero interval", "long interval", "NaN rtt", "negative bytes",
        "too many bytes", "infinite jitter", "huge height", "negative frames", "too much securing",
    };

    [Theory]
    [MemberData(nameof(Invalid))]
    public void Junk_is_rejected_with_one_constant_message(string what)
    {
        var report = Report();
        CallStatsInput? stats = what switch
        {
            "no stats" => null,
            "empty platform" => report with { Platform = "" },
            "long platform" => report with { Platform = new string('x', 33) },
            "zero interval" => report with { IntervalSeconds = 0 },
            "long interval" => report with { IntervalSeconds = 121 },
            "NaN rtt" => report with { RttMs = double.NaN },
            "negative bytes" => report with { VideoReceived = Received with { Bytes = -1 } },
            "too many bytes" => report with { VideoSent = Sent with { Bytes = CallStatsRules.MaxBytes + 1 } },
            "infinite jitter" => report with { AudioReceived = Received with { JitterMs = double.PositiveInfinity } },
            "huge height" => report with { VideoReceived = Received with { Height = 100_000 } },
            "negative frames" => report with { E2ee = E2ee with { FramesFailed = -5 } },
            "too much securing" => report with { E2ee = E2ee with { SecuringSeconds = CallStatsRules.MaxSecuringSeconds + 1 } },
            _ => throw new ArgumentOutOfRangeException(nameof(what)),
        };

        var result = _validator.Validate(new ReportCallStatsCommand("conn", stats));
        Assert.Equal(["Invalid stats."], result.Errors.Select(e => e.ErrorMessage));
    }

    [Fact]
    public async Task Only_participants_of_a_call_can_report()
    {
        var (metrics, _) = TestMetrics.Create(_rooms);
        var error = await Assert.ThrowsAsync<NotFoundException>(async () =>
            await new ReportCallStatsCommandHandler(_rooms, metrics, _usage).Handle(new ReportCallStatsCommand("conn-x", Report()), _ct));
        Assert.Equal("Join a room first.", error.Message);
    }

    [Fact]
    public async Task Reports_become_metrics_labelled_by_kind_direction_platform_and_path_only()
    {
        _rooms.Join("conn-a");
        var (metrics, factory) = TestMetrics.Create(_rooms);
        using var bytes = new MetricCollector<double>(factory, CipheroomMetrics.MeterName, "cipheroom.call.bytes");
        using var lost = new MetricCollector<double>(factory, CipheroomMetrics.MeterName, "cipheroom.call.packets_lost");
        using var rtt = new MetricCollector<double>(factory, CipheroomMetrics.MeterName, "cipheroom.call.rtt");
        using var frames = new MetricCollector<double>(factory, CipheroomMetrics.MeterName, "cipheroom.e2ee.frames");

        await new ReportCallStatsCommandHandler(_rooms, metrics, _usage).Handle(new ReportCallStatsCommand("conn-a", Report()), _ct);

        var videoIn = Assert.Single(bytes.GetMeasurementSnapshot(), m => (string)m.Tags["kind"]! == "video" && (string)m.Tags["direction"]! == "received");
        Assert.Equal(2_000_000, videoIn.Value);
        Assert.Equal(["direction", "kind", "path", "platform"], videoIn.Tags.Keys.Order());
        Assert.Equal(("ios-safari", "direct"), ((string)videoIn.Tags["platform"]!, (string)videoIn.Tags["path"]!));
        Assert.Equal(2, lost.GetMeasurementSnapshot().Count); // received audio + video only
        Assert.Equal(0.042, rtt.LastMeasurement!.Value, 6);
        Assert.Equal(30, frames.GetMeasurementSnapshot().Single(m => (string)m.Tags["result"]! == "missing_key").Value);
    }

    [Fact]
    public async Task Received_bytes_feed_the_usage_estimate()
    {
        _rooms.Join("conn-a");
        var (metrics, _) = TestMetrics.Create(_rooms);

        await new ReportCallStatsCommandHandler(_rooms, metrics, _usage).Handle(new ReportCallStatsCommand("conn-a", Report()), _ct);

        var report = Report();
        Assert.Equal([(report.AudioReceived!.Bytes + report.VideoReceived!.Bytes, report.IntervalSeconds)], _usage.Recorded);
    }

    [Fact]
    public async Task Unknown_platforms_and_paths_are_recorded_as_other_and_unknown()
    {
        _rooms.Join("conn-a");
        var (metrics, factory) = TestMetrics.Create(_rooms);
        using var reports = new MetricCollector<long>(factory, CipheroomMetrics.MeterName, "cipheroom.call.reports");
        using var bytes = new MetricCollector<double>(factory, CipheroomMetrics.MeterName, "cipheroom.call.bytes");

        await new ReportCallStatsCommandHandler(_rooms, metrics, _usage).Handle(
            new ReportCallStatsCommand("conn-a", Report(platform: "tv-browser-9000", path: "carrier-pigeon")), _ct);

        Assert.Equal("other", reports.LastMeasurement!.Tags["platform"]);
        Assert.Equal("unknown", bytes.LastMeasurement!.Tags["path"]);
    }
}
