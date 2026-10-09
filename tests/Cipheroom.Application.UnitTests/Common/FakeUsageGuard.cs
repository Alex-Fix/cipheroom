using Cipheroom.Application.Common.Interfaces;

namespace Cipheroom.Application.UnitTests.Common;

/// <summary>A usage guard pinned to <see cref="Level"/>, recording what reports credit to it.</summary>
internal sealed class FakeUsageGuard : IUsageGuard, IUsageLedger
{
    public UsageLevel Level { get; set; } = UsageLevel.Normal;

    public List<(double Bytes, double IntervalSeconds)> Recorded { get; } = [];

    public UsageStatus Current => new(Level, Level == UsageLevel.Normal ? null : 90, new DateTimeOffset(2026, 11, 1, 0, 0, 0, TimeSpan.Zero));

    public event Action<UsageStatus>? Changed
    {
        add { }
        remove { }
    }

    public void RecordReceived(double bytes, double intervalSeconds) => Recorded.Add((bytes, intervalSeconds));
}
