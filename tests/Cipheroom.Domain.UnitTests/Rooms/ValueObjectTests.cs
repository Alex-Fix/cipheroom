using Cipheroom.Domain.Rooms;

namespace Cipheroom.Domain.UnitTests.Rooms;

public sealed class ValueObjectTests
{
    [Fact]
    public void RoomId_accepts_host_key_derived_ids() =>
        Assert.Equal("k3fqz2abcdefghijklmnopqrst", new RoomId("k3fqz2abcdefghijklmnopqrst").Value);

    [Theory]
    [InlineData("abc")]
    [InlineData("a1b2-c3d4-e5f6")] // the old random format: those links no longer work
    [InlineData("K3FQZ2ABCDEFGHIJKLMNOPQRST")]
    [InlineData("k3fqz2abcdefghijklmnopqrs1")] // 1 isn't base32
    [InlineData("k3fqz2abcdefghijklmnopqrstu")]
    [InlineData("")]
    public void RoomId_rejects_everything_else(string value)
    {
        Assert.False(RoomId.IsValid(value));
        Assert.Throws<ArgumentException>(() => new RoomId(value));
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
