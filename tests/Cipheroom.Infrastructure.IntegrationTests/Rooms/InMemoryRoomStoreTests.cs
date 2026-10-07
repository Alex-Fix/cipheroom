using Cipheroom.Domain.Rooms;
using Cipheroom.Infrastructure.Rooms;

namespace Cipheroom.Infrastructure.IntegrationTests.Rooms;

public sealed class InMemoryRoomStoreTests
{
    private readonly InMemoryRoomStore _store = new();
    private static readonly RoomId Room = new("room-1");

    [Fact]
    public void Join_returns_who_was_already_there()
    {
        Assert.True(_store.TryJoin(Room, "a", new DisplayName("Alice"), TestIdentity.Keys, out var alice, out var beforeAlice));
        Assert.True(_store.TryJoin(Room, "b", new DisplayName("Bob"), TestIdentity.Keys, out _, out var beforeBob));

        Assert.Empty(beforeAlice);
        Assert.Equal([alice], beforeBob);
    }

    [Fact]
    public void A_connection_can_only_be_in_one_room()
    {
        _store.TryJoin(Room, "a", new DisplayName("Alice"), TestIdentity.Keys, out _, out _);
        Assert.False(_store.TryJoin(new RoomId("room-2"), "a", new DisplayName("Alice"), TestIdentity.Keys, out _, out _));
    }

    [Fact]
    public void Leaving_the_last_participant_drops_the_room()
    {
        _store.TryJoin(Room, "a", new DisplayName("Alice"), TestIdentity.Keys, out var alice, out _);

        Assert.Equal(alice, _store.Leave("a"));
        Assert.Null(_store.FindByConnection("a"));
        Assert.Null(_store.Leave("a"));

        // A fresh join sees an empty room again.
        Assert.True(_store.TryJoin(Room, "b", new DisplayName("Bob"), TestIdentity.Keys, out _, out var others));
        Assert.Empty(others);
    }

    [Fact]
    public async Task Concurrent_joins_and_leaves_stay_consistent()
    {
        const int count = 200;
        await Task.WhenAll(Enumerable.Range(0, count).Select(i => Task.Run(() =>
        {
            Assert.True(_store.TryJoin(Room, $"c{i}", new DisplayName($"P{i}"), TestIdentity.Keys, out _, out _));
            if (i % 2 == 0)
                Assert.NotNull(_store.Leave($"c{i}"));
        }, TestContext.Current.CancellationToken)));

        Assert.True(_store.TryJoin(Room, "last", new DisplayName("Last"), TestIdentity.Keys, out _, out var others));
        Assert.Equal(count / 2, others.Count);
        Assert.Equal(count / 2, others.Select(p => p.Id).Distinct().Count());
    }
}
