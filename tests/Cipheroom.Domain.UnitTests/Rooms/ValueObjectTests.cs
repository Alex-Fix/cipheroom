using Cipheroom.Domain.Rooms;

namespace Cipheroom.Domain.UnitTests.Rooms;

public sealed class ValueObjectTests
{
    [Theory]
    [InlineData("abc")]
    [InlineData("a1b2-c3d4-e5f6")]
    public void RoomId_accepts_invite_link_ids(string value) => Assert.Equal(value, new RoomId(value).Value);

    [Theory]
    [InlineData("ab")]
    [InlineData("UPPER")]
    [InlineData("has space")]
    [InlineData("")]
    public void RoomId_rejects_everything_else(string value)
    {
        Assert.False(RoomId.IsValid(value));
        Assert.Throws<ArgumentException>(() => new RoomId(value));
    }

    [Fact]
    public void RoomId_length_bounds_match_the_pattern()
    {
        Assert.True(RoomId.IsValid(new string('a', RoomId.MinLength)));
        Assert.True(RoomId.IsValid(new string('a', RoomId.MaxLength)));
        Assert.False(RoomId.IsValid(new string('a', RoomId.MaxLength + 1)));
    }

    [Fact]
    public void DisplayName_is_trimmed() => Assert.Equal("Bob", new DisplayName("  Bob ").Value);

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void DisplayName_rejects_blank(string value) => Assert.Throws<ArgumentException>(() => new DisplayName(value));

    [Fact]
    public void DisplayName_allows_up_to_max_length()
    {
        Assert.True(DisplayName.IsValid(new string('a', DisplayName.MaxLength)));
        Assert.False(DisplayName.IsValid(new string('a', DisplayName.MaxLength + 1)));
    }

    [Fact]
    public void ParticipantId_is_random_64_bit_hex()
    {
        var a = ParticipantId.New();
        Assert.Matches("^[0-9a-f]{16}$", a.Value);
        Assert.NotEqual(a, ParticipantId.New());
    }

    [Theory]
    [InlineData("0123456789abcdef", true)]
    [InlineData("0123456789ABCDEF", false)]
    [InlineData("0123456789abcde", false)]
    [InlineData("../../sessions/x", false)]
    [InlineData(null, false)]
    public void ParticipantId_validation_accepts_only_ids_we_issue(string? value, bool valid) =>
        Assert.Equal(valid, ParticipantId.IsValid(value));
}
