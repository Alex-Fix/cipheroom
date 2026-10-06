using Cipheroom.Domain.Rooms;

namespace Cipheroom.Domain.UnitTests.Rooms;

public sealed class RoomTests
{
    private readonly Room _room = new(new RoomId("room-1"));

    [Fact]
    public void Join_adds_a_participant_with_a_fresh_id()
    {
        var alice = _room.Join("conn-a", new DisplayName("Alice"));

        Assert.Equal(new RoomId("room-1"), alice.RoomId);
        Assert.Equal("conn-a", alice.ConnectionId);
        Assert.Equal([alice], _room.Participants);
        Assert.False(_room.IsEmpty);
    }

    [Fact]
    public void The_same_connection_cannot_join_twice()
    {
        _room.Join("conn-a", new DisplayName("Alice"));
        Assert.Throws<InvalidOperationException>(() => _room.Join("conn-a", new DisplayName("Alice")));
    }

    [Fact]
    public void Leave_removes_only_that_participant()
    {
        var alice = _room.Join("conn-a", new DisplayName("Alice"));
        var bob = _room.Join("conn-b", new DisplayName("Bob"));

        Assert.Equal(alice, _room.Leave("conn-a"));
        Assert.Equal([bob], _room.Participants);
    }

    [Fact]
    public void Leave_for_unknown_connection_is_a_no_op()
    {
        Assert.Null(_room.Leave("nobody"));
        Assert.True(_room.IsEmpty);
    }
}
