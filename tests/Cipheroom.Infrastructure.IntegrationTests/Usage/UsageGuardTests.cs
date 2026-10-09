using System.Diagnostics.Metrics;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Common.Telemetry;
using Cipheroom.Infrastructure.Rooms;
using Cipheroom.Infrastructure.Usage;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;

namespace Cipheroom.Infrastructure.IntegrationTests.Usage;

/// <summary>The usage guard's figure, levels and file (docs/plans/2026-10-09-usage-guard-design.md).</summary>
public sealed class UsageGuardTests : IDisposable
{
    private const long GB = 1_000_000_000;
    private const double Factor = 1.1;

    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 10, 9, 12, 0, 0, TimeSpan.Zero));
    private readonly string _file = Path.Combine(Path.GetTempPath(), $"cipheroom-usage-test-{Guid.NewGuid():N}.json");
    private readonly ServiceProvider _services = new ServiceCollection().AddMetrics().BuildServiceProvider();

    public void Dispose()
    {
        File.Delete(_file);
        _services.Dispose();
    }

    [Fact]
    public void Without_cloudflare_data_the_estimate_counts_with_the_relay_factor()
    {
        var guard = Guard();
        Report(guard, 790 * GB / Factor);
        Assert.Equal(UsageLevel.Normal, guard.Evaluate().Level);

        Report(guard, 20 * GB / Factor);
        var status = guard.Evaluate();
        Assert.Equal((UsageLevel.Saving, 81), (status.Level, status.Percent));
        Assert.Equal(new DateTimeOffset(2026, 11, 1, 0, 0, 0, TimeSpan.Zero), status.ResetsAt);
    }

    [Fact]
    public void Fresh_cloudflare_data_counts_plus_the_estimate_since_an_hour_before_the_poll()
    {
        var guard = Guard();
        Report(guard, 500 * GB / Factor); // two hours before the poll: Cloudflare already has it
        _time.Advance(TimeSpan.FromHours(1.5));
        Report(guard, 100 * GB / Factor); // half an hour before the poll: maybe not yet in Cloudflare's figure
        _time.Advance(TimeSpan.FromMinutes(30));
        guard.CloudflarePolled(new RealtimeUsage(700 * GB, 50 * GB), _time.GetUtcNow());
        _time.Advance(TimeSpan.FromMinutes(10));
        Report(guard, 50 * GB / Factor);

        // 750 from Cloudflare + 100 + 50 since an hour before its poll.
        Assert.Equal((UsageLevel.Saving, 90), Level(guard));
    }

    [Fact]
    public void Stale_cloudflare_data_falls_back_to_the_estimate()
    {
        var guard = Guard();
        guard.CloudflarePolled(new RealtimeUsage(10 * GB, 0), _time.GetUtcNow());
        Report(guard, 850 * GB / Factor);
        _time.Advance(TimeSpan.FromMinutes(46));

        Assert.Equal((UsageLevel.Saving, 85), Level(guard));
    }

    [Fact]
    public void Within_a_month_the_level_only_rises_and_it_resets_with_the_month()
    {
        var guard = Guard();
        Report(guard, 960 * GB / Factor);
        Assert.Equal(UsageLevel.AudioOnly, guard.Evaluate().Level);

        // A later, lower Cloudflare figure (and no recent reports) doesn't lower it.
        _time.Advance(TimeSpan.FromHours(2));
        guard.CloudflarePolled(new RealtimeUsage(100 * GB, 0), _time.GetUtcNow());
        Assert.Equal(UsageLevel.AudioOnly, guard.Evaluate().Level);

        _time.SetUtcNow(new DateTimeOffset(2026, 11, 1, 0, 0, 1, TimeSpan.Zero));
        Assert.Equal((UsageLevel.Normal, (int?)null), Level(guard));
    }

    [Fact]
    public void Changes_are_announced_once()
    {
        var guard = Guard();
        List<UsageStatus> changes = [];
        guard.Changed += changes.Add;
        guard.Evaluate();
        Report(guard, 960 * GB / Factor);
        guard.Evaluate();
        guard.Evaluate();

        Assert.Equal([UsageLevel.Normal, UsageLevel.AudioOnly], changes.Select(c => c.Level));
    }

    [Fact]
    public async Task The_estimate_and_level_survive_a_restart()
    {
        var first = Guard();
        await first.StartAsync(TestContext.Current.CancellationToken);
        Report(first, 830 * GB / Factor);
        await first.StopAsync(TestContext.Current.CancellationToken);

        var second = Guard();
        await second.StartAsync(TestContext.Current.CancellationToken);
        Assert.Equal((UsageLevel.Saving, 83), Level(second));
        await second.StopAsync(TestContext.Current.CancellationToken);
        Assert.DoesNotContain("conn", await File.ReadAllTextAsync(_file, TestContext.Current.CancellationToken), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_file_from_last_month_or_a_corrupt_one_starts_from_zero()
    {
        var first = Guard();
        await first.StartAsync(TestContext.Current.CancellationToken);
        Report(first, 900 * GB / Factor);
        await first.StopAsync(TestContext.Current.CancellationToken);

        _time.SetUtcNow(new DateTimeOffset(2026, 11, 2, 0, 0, 0, TimeSpan.Zero));
        var nextMonth = Guard();
        await nextMonth.StartAsync(TestContext.Current.CancellationToken);
        Assert.Equal(UsageLevel.Normal, nextMonth.Evaluate().Level);
        await nextMonth.StopAsync(TestContext.Current.CancellationToken);

        await File.WriteAllTextAsync(_file, "{not json", TestContext.Current.CancellationToken);
        var corrupt = Guard();
        await corrupt.StartAsync(TestContext.Current.CancellationToken);
        Assert.Equal(UsageLevel.Normal, corrupt.Evaluate().Level);
        await corrupt.StopAsync(TestContext.Current.CancellationToken);
    }

    [Fact]
    public void A_single_report_is_capped()
    {
        var guard = Guard();
        guard.RecordReceived(1e15, 15); // a modified client claiming a petabyte
        Assert.Equal(UsageLevel.Normal, guard.Evaluate().Level);
    }

    [Fact]
    public void Disabled_means_never_limited_and_force_level_works_only_in_development()
    {
        var disabled = Guard(o => o.Enabled = false);
        Report(disabled, 999 * GB);
        Assert.Equal(UsageLevel.Normal, disabled.Evaluate().Level);

        Assert.Equal(UsageLevel.Normal, Guard(o => o.ForceLevel = UsageLevel.Paused).Evaluate().Level);
        Assert.Equal(UsageLevel.Paused, Guard(o => o.ForceLevel = UsageLevel.Paused, "Development").Evaluate().Level);
    }

    [Fact]
    public void Thresholds_must_rise()
    {
        var options = new UsageGuardOptions { SavingPercent = 90, AudioOnlyPercent = 80 };
        Assert.NotEmpty(options.Validate(new System.ComponentModel.DataAnnotations.ValidationContext(options)));
    }

    private static (UsageLevel, int?) Level(UsageGuard guard)
    {
        var status = guard.Evaluate();
        return (status.Level, status.Percent);
    }

    /// <summary>Records <paramref name="bytes"/> as received, in reports small enough to stay under the per-report cap.</summary>
    private static void Report(UsageGuard guard, double bytes)
    {
        const double perReport = 90_000_000; // under 50 Mbit/s × 15 s
        for (var left = bytes; left > 0; left -= perReport)
            guard.RecordReceived(Math.Min(left, perReport), 15);
    }

    private UsageGuard Guard(Action<UsageGuardOptions>? configure = null, string environment = "Production")
    {
        var options = new UsageGuardOptions { DataPath = _file };
        configure?.Invoke(options);
        var metrics = new CipheroomMetrics(_services.GetRequiredService<IMeterFactory>(), new InMemoryRoomStore(), _time);
        return new UsageGuard(
            new StaticOptionsMonitor<UsageGuardOptions>(options),
            Options.Create(new RealtimeUsageOptions()),
            new TestEnvironment(environment),
            metrics,
            _time,
            NullLogger<UsageGuard>.Instance);
    }

    private sealed class StaticOptionsMonitor<T>(T value) : IOptionsMonitor<T>
    {
        public T CurrentValue => value;

        public T Get(string? name) => value;

        public IDisposable? OnChange(Action<T, string?> listener) => null;
    }

    internal sealed class TestEnvironment(string name) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = name;
        public string ApplicationName { get; set; } = "Cipheroom.Tests";
        public string ContentRootPath { get; set; } = Path.GetTempPath();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
