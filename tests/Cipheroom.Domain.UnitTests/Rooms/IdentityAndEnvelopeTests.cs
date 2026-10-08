using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Domain.UnitTests.Rooms;

public sealed class IdentityAndEnvelopeTests
{
    private readonly Room _room = new(TestRooms.Id1);

    [Fact]
    public void IdentityKeys_accept_unpadded_base64url_of_32_32_64_bytes() =>
        Assert.Equal(TestIdentity.Ed25519Pub, TestIdentity.Keys.Ed25519Pub);

    [Theory]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")] // 42 characters
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")] // 44 characters
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")] // padded
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+")] // base64, not base64url
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA AA")]
    [InlineData("")]
    [InlineData(null)]
    public void IdentityKeys_reject_anything_else(string? key)
    {
        Assert.False(IdentityKeys.IsValid(key, TestIdentity.X25519Pub, TestIdentity.Sig));
        Assert.False(IdentityKeys.IsValid(TestIdentity.Ed25519Pub, key, TestIdentity.Sig));
        Assert.Throws<ArgumentException>(() => new IdentityKeys(key!, TestIdentity.X25519Pub, TestIdentity.Sig));
    }

    [Fact]
    public void IdentityKeys_reject_a_signature_of_the_wrong_length() =>
        Assert.False(IdentityKeys.IsValid(TestIdentity.Ed25519Pub, TestIdentity.X25519Pub, TestIdentity.Ed25519Pub));

    [Fact]
    public void Participants_keep_their_identity() =>
        Assert.Equal(TestRooms.Identity("conn-a"), _room.Join("conn-a").Identity);

    [Fact]
    public void Envelopes_go_to_other_participants_of_the_room()
    {
        var alice = _room.Join("conn-a");
        var bob = _room.Join("conn-b");
        var carol = _room.Join("conn-c");

        Assert.Equal([carol, bob], _room.EnvelopeRecipients(alice.Id, [carol.Id, bob.Id]));
    }

    [Fact]
    public void Envelopes_never_go_outside_the_room_or_back_to_the_sender()
    {
        var alice = _room.Join("conn-a");
        var stranger = new Room(TestRooms.Id2).Join("conn-x");

        foreach (var to in new[] { stranger.Id, alice.Id, ParticipantId.New() })
        {
            var error = Assert.Throws<DomainException>(() => _room.EnvelopeRecipients(alice.Id, [to]));
            Assert.Equal("Invalid key envelope.", error.Message);
        }
    }
}
