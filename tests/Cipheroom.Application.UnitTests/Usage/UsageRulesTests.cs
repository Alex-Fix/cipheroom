using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Usage;

namespace Cipheroom.Application.UnitTests.Usage;

public sealed class UsageRulesTests
{
    private const long FreeTier = 1_000_000_000_000;

    [Theory]
    [InlineData(0, UsageLevel.Normal)]
    [InlineData(799_999_999_999, UsageLevel.Normal)]
    [InlineData(800_000_000_000, UsageLevel.Saving)]
    [InlineData(950_000_000_000, UsageLevel.AudioOnly)]
    [InlineData(990_000_000_000, UsageLevel.Paused)]
    [InlineData(2_000_000_000_000, UsageLevel.Paused)]
    public void Levels_follow_the_thresholds(double used, UsageLevel level) =>
        Assert.Equal(level, UsageRules.LevelFor(used, FreeTier, 80, 95, 99));

    [Fact]
    public void Percent_is_rounded_down_but_at_least_one_once_anything_is_used()
    {
        Assert.Equal(83, UsageRules.Percent(839_999_999_999, FreeTier));
        Assert.Equal(1, UsageRules.Percent(1_600_000_000, FreeTier)); // 0.16 %
        Assert.Equal(0, UsageRules.Percent(0, FreeTier));
    }

    [Fact]
    public void Thresholds_may_have_decimals() =>
        Assert.Equal(UsageLevel.Saving, UsageRules.LevelFor(1_600_000_000, FreeTier, 0.1, 95, 99));

    [Fact]
    public void The_month_resets_on_the_first_at_midnight_utc()
    {
        var late = new DateTimeOffset(2026, 12, 31, 23, 30, 0, TimeSpan.FromHours(-5)); // already January in UTC
        Assert.Equal("2027-01", UsageRules.MonthOf(late));
        Assert.Equal(new DateTimeOffset(2027, 2, 1, 0, 0, 0, TimeSpan.Zero), UsageRules.ResetsAt(late));
    }

    [Fact]
    public void A_report_can_credit_at_most_the_cap_for_its_interval_times_the_factor()
    {
        // 50 Mbit/s for 15 s = 93.75 MB.
        Assert.Equal(93_750_000 * 1.1, UsageRules.Credited(1e12, 15, 50, 1.1), 3);
        Assert.Equal(1_000 * 1.1, UsageRules.Credited(1_000, 15, 50, 1.1), 6);
        Assert.Equal(0, UsageRules.Credited(-5, 15, 50, 1.1));
        Assert.Equal(0, UsageRules.Credited(double.NaN, 15, 50, 1.1));
        Assert.Equal(0, UsageRules.Credited(1_000, 0, 50, 1.1));
    }
}
