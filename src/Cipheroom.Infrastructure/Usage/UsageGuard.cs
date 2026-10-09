using System.Text.Json;
using System.Text.Json.Serialization;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Common.Telemetry;
using Cipheroom.Application.Usage;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Cipheroom.Infrastructure.Usage;

/// <summary>
/// Keeps this month's Cloudflare Realtime traffic under the free tier (docs/plans/2026-10-09-usage-guard-design.md).
/// The figure is Cloudflare's month-to-date egress while its last poll is fresh, plus the api's own estimate (from
/// browsers' call-quality reports) for the time since a little before that poll; without fresh Cloudflare data, the
/// estimate for the whole month. The level only rises within a month (unless the thresholds change) and drops at the reset. The estimate survives
/// restarts in a small file of numbers and timestamps (no ids, names or rooms).
/// </summary>
public sealed partial class UsageGuard(
    IOptionsMonitor<UsageGuardOptions> options,
    IOptions<RealtimeUsageOptions> freeTier,
    IHostEnvironment environment,
    CipheroomMetrics metrics,
    TimeProvider time,
    ILogger<UsageGuard> logger) : BackgroundService, IUsageGuard, IUsageLedger
{
    private static readonly TimeSpan Bucket = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan BucketRetention = TimeSpan.FromHours(24);
    private static readonly TimeSpan EvaluateEvery = TimeSpan.FromMinutes(1);

    private readonly Lock _gate = new();
    private readonly SortedDictionary<long, double> _buckets = [];
    private string _month = "";
    private double _estimate;
    private long? _cloudflareBytes;
    private DateTimeOffset _cloudflareAt;
    private UsageLevel _level;
    /// <summary>The thresholds <see cref="_level"/> was reached under: other thresholds start it over.</summary>
    private string _thresholds = "";
    private bool _dirty;
    private UsageStatus? _current;

    public event Action<UsageStatus>? Changed;

    public UsageStatus Current => _current ?? Evaluate();

    private IDisposable? _optionsChanged;

    private UsageGuardOptions Options => options.CurrentValue;

    /// <summary>A relative path is relative to the app's content root (the project folder under scripts/dev.sh).</summary>
    private string DataPath => Path.IsPathRooted(Options.DataPath)
        ? Options.DataPath
        : Path.GetFullPath(Path.Combine(environment.ContentRootPath, Options.DataPath));

    private long FreeTierBytes => freeTier.Value.FreeTierGb * 1_000_000_000L;

    public void RecordReceived(double bytes, double intervalSeconds)
    {
        var credited = UsageRules.Credited(bytes, intervalSeconds, Options.MaxReportMbps, Options.EstimateFactor);
        if (credited <= 0)
            return;
        var now = time.GetUtcNow();
        lock (_gate)
        {
            RollMonth(now);
            _estimate += credited;
            var bucket = BucketOf(now);
            _buckets[bucket] = _buckets.GetValueOrDefault(bucket) + credited;
            _dirty = true;
        }
    }

    /// <summary>A successful Cloudflare poll (from <see cref="RealtimeUsagePoller"/>).</summary>
    public void CloudflarePolled(RealtimeUsage usage, DateTimeOffset at)
    {
        lock (_gate)
        {
            RollMonth(at);
            _cloudflareBytes = usage.TotalEgressBytes;
            _cloudflareAt = at;
            _dirty = true;
        }
        Evaluate();
    }

    /// <summary>Recomputes the level; raises <see cref="Changed"/> when it (or the shown percent) changed.</summary>
    public UsageStatus Evaluate()
    {
        var now = time.GetUtcNow();
        UsageStatus status;
        bool changed;
        double estimate;
        lock (_gate)
        {
            RollMonth(now);
            // Thresholds changed (deploy/.env): the level is worked out again from the figure, not carried over.
            var thresholds = Thresholds();
            if (thresholds != _thresholds)
            {
                _thresholds = thresholds;
                _level = UsageLevel.Normal;
                _dirty = true;
            }
            var used = UsedBytes(now);
            var computed = UsageRules.LevelFor(used, FreeTierBytes, Options.SavingPercent, Options.AudioOnlyPercent, Options.PausedPercent);
            if (computed > _level)
            {
                _level = computed;
                _dirty = true;
            }

            var level = Options.ForceLevel is { } forced && environment.IsDevelopment() ? forced
                : Options.Enabled ? _level
                : UsageLevel.Normal;
            int? percent = level == UsageLevel.Normal ? null : UsageRules.Percent(used, FreeTierBytes);
            status = new UsageStatus(level, percent, UsageRules.ResetsAt(now));
            changed = _current is null || _current.Level != status.Level || _current.Percent != status.Percent;
            if (changed)
                _current = status;
            else
                status = _current!;
            estimate = _estimate;
        }

        metrics.UsageGuardUpdated((int)status.Level, estimate);
        if (changed)
        {
            if (status.Level != UsageLevel.Normal)
                LogLevel(logger, status.Level, status.Percent ?? 0);
            Changed?.Invoke(status);
        }
        return status;
    }

    /// <summary>Loads the saved state before anything can ask (ExecuteAsync runs in the background).</summary>
    public override Task StartAsync(CancellationToken cancellationToken)
    {
        // New thresholds, or a forced level while trying the guard out (Development), apply at once.
        _optionsChanged = options.OnChange(_ => Evaluate());
        Load();
        if (!Options.Enabled)
            LogDisabled(logger);
        Evaluate();
        return base.StartAsync(cancellationToken);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            Evaluate();
            Save();
            try
            {
                await Task.Delay(EvaluateEvery, time, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        _optionsChanged?.Dispose();
        await base.StopAsync(cancellationToken);
        Save();
    }

    /// <summary>Cloudflare's figure while fresh, plus our estimate since a little before it; else the month's estimate.</summary>
    private double UsedBytes(DateTimeOffset now)
    {
        if (_cloudflareBytes is { } cloudflare && now - _cloudflareAt <= TimeSpan.FromMinutes(Options.FreshPollMinutes))
            return cloudflare + EstimateSince(_cloudflareAt - TimeSpan.FromMinutes(Options.AnalyticsLagMinutes));
        return _estimate;
    }

    private double EstimateSince(DateTimeOffset from)
    {
        var first = BucketOf(from);
        return _buckets.Where(b => b.Key >= first).Sum(b => b.Value);
    }

    /// <summary>A new month starts from zero (the level too).</summary>
    private void RollMonth(DateTimeOffset now)
    {
        var month = UsageRules.MonthOf(now);
        if (month != _month)
        {
            _month = month;
            _estimate = 0;
            _buckets.Clear();
            _cloudflareBytes = null;
            _level = UsageLevel.Normal;
            _dirty = true;
        }

        var oldest = BucketOf(now - BucketRetention);
        foreach (var stale in _buckets.Keys.TakeWhile(k => k < oldest).ToArray())
            _buckets.Remove(stale);
    }

    private string Thresholds() => string.Create(
        System.Globalization.CultureInfo.InvariantCulture,
        $"{Options.SavingPercent}/{Options.AudioOnlyPercent}/{Options.PausedPercent}/{FreeTierBytes}");

    private static long BucketOf(DateTimeOffset at) => at.ToUnixTimeSeconds() / (long)Bucket.TotalSeconds * (long)Bucket.TotalSeconds;

    private void Load()
    {
        try
        {
            if (!File.Exists(DataPath))
                return;
            var file = JsonSerializer.Deserialize(File.ReadAllText(DataPath), UsageFileContext.Default.UsageFile);
            if (file is null)
                return;
            lock (_gate)
            {
                _month = file.Month;
                _estimate = Math.Max(0, file.EstimateBytes);
                _buckets.Clear();
                foreach (var (bucket, bytes) in file.Buckets)
                    _buckets[bucket] = Math.Max(0, bytes);
                _cloudflareBytes = file.CloudflareBytes;
                _cloudflareAt = file.CloudflareAt ?? default;
                _level = file.Level;
                _thresholds = file.Thresholds ?? "";
                RollMonth(time.GetUtcNow());
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            LogLoadFailed(logger, ex);
        }
    }

    private void Save()
    {
        UsageFile file;
        lock (_gate)
        {
            if (!_dirty)
                return;
            file = new UsageFile(_month, _estimate, new Dictionary<long, double>(_buckets), _cloudflareBytes,
                _cloudflareBytes is null ? null : _cloudflareAt, _level, _thresholds);
            _dirty = false;
        }
        try
        {
            var directory = Path.GetDirectoryName(DataPath);
            if (!string.IsNullOrEmpty(directory))
                Directory.CreateDirectory(directory);
            var temp = DataPath + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(file, UsageFileContext.Default.UsageFile));
            File.Move(temp, DataPath, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            lock (_gate)
                _dirty = true;
            LogSaveFailed(logger, ex);
        }
    }

    [LoggerMessage(Level = Microsoft.Extensions.Logging.LogLevel.Warning, Message = "Usage guard: {Level} ({Percent}% of this month's free tier)")]
    private static partial void LogLevel(ILogger logger, UsageLevel level, int percent);

    [LoggerMessage(Level = Microsoft.Extensions.Logging.LogLevel.Warning, Message = "Usage guard is disabled: calls are never limited, the free tier is not enforced")]
    private static partial void LogDisabled(ILogger logger);

    [LoggerMessage(Level = Microsoft.Extensions.Logging.LogLevel.Warning, Message = "Usage guard: couldn't read the usage file; starting from zero until the next Cloudflare poll")]
    private static partial void LogLoadFailed(ILogger logger, Exception exception);

    [LoggerMessage(Level = Microsoft.Extensions.Logging.LogLevel.Warning, Message = "Usage guard: couldn't save the usage file (estimate kept in memory)")]
    private static partial void LogSaveFailed(ILogger logger, Exception exception);
}

/// <summary>What survives a restart: numbers and timestamps only.</summary>
internal sealed record UsageFile(
    string Month,
    double EstimateBytes,
    Dictionary<long, double> Buckets,
    long? CloudflareBytes,
    DateTimeOffset? CloudflareAt,
    UsageLevel Level,
    string? Thresholds = null);

[JsonSerializable(typeof(UsageFile))]
[JsonSourceGenerationOptions(WriteIndented = false, UseStringEnumConverter = true)]
internal sealed partial class UsageFileContext : JsonSerializerContext;
