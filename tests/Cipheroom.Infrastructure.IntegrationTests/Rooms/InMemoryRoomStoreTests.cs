using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;
using Cipheroom.Infrastructure.Rooms;

namespace Cipheroom.Infrastructure.IntegrationTests.Rooms;

public sealed class InMemoryRoomStoreTests
{
    private readonly InMemoryRoomStore _store = new();
    private static readonly RoomId Room = new("aaaaaaaaaaaaaaaaaaaaaaaaaa");
    private static readonly HostKeys Host = new(TestIdentity.Ed25519Pub, TestIdentity.X25519Pub);

    [Fact]
    public void Enter_registers_members_and_lobby_guests()
    {
        var host = _store.Enter(Room, "a", room => room.JoinAsHost("a", TestIdentity.Keys, VideoCodecs.Baseline, Host, TestIdentity.Sig));
        var guest = _store.Enter(Room, "b", room => room.EnterLobby("b", TestIdentity.Keys, VideoCodecs.Baseline, DateTimeOffset.UnixEpoch));

        Assert.Equal(host, _store.FindByConnection("a"));
        Assert.Null(_store.FindByConnection("b"));
        Assert.Equal(guest, _store.InAnyRoom("b", room => room.Lobby.Single()));
        Assert.Equal(new(1, 1), _store.Stats());
    }

    [Fact]
    public void Lobby_guests_are_not_admitted_to_member_actions()
    {
        _store.Enter(Room, "b", room => room.EnterLobby("b", TestIdentity.Keys, VideoCodecs.Baseline, DateTimeOffset.UnixEpoch));

        var error = Assert.Throws<DomainException>(() => _store.InRoom("b", (_, self) => self));
        Assert.Equal("Not admitted.", error.Message);
        Assert.Null(_store.InRoom("nobody", (_, self) => self));
    }

    [Fact]
    public void A_connection_can_only_be_in_one_room()
    {
        _store.Enter(Room, "a", room => room.JoinAsHost("a", TestIdentity.Keys, VideoCodecs.Baseline, Host, TestIdentity.Sig));

        var error = Assert.Throws<DomainException>(() =>
            _store.Enter(new RoomId("bbbbbbbbbbbbbbbbbbbbbbbbbb"), "a", room => room.EnterLobby("a", TestIdentity.Keys, VideoCodecs.Baseline, DateTimeOffset.UnixEpoch)));
        Assert.Equal("Already in a room.", error.Message);
    }

    [Fact]
    public void A_failed_enter_leaves_no_room_behind()
    {
        Assert.Throws<DomainException>(() => _store.Enter(Room, "a", object (_) => throw new DomainException("No.")));
        Assert.Equal(new(0, 0), _store.Stats());
    }

    [Fact]
    public void Connections_the_room_drops_are_forgotten_and_empty_rooms_go()
    {
        var host = _store.Enter(Room, "a", room => room.JoinAsHost("a", TestIdentity.Keys, VideoCodecs.Baseline, Host, TestIdentity.Sig));
        _store.Enter(Room, "b", room => room.EnterLobby("b", TestIdentity.Keys, VideoCodecs.Baseline, DateTimeOffset.UnixEpoch));

        _store.InRoom("a", (room, self) => room.End(self.Id));

        Assert.Null(_store.InAnyRoom("a", room => room));
        Assert.Null(_store.InAnyRoom("b", room => room));
        Assert.Equal(new(0, 0), _store.Stats());
        Assert.NotNull(host);
    }

    [Fact]
    public async Task Concurrent_entries_and_leaves_stay_consistent()
    {
        const int count = 200;
        _store.Enter(Room, "host", room => room.JoinAsHost("host", TestIdentity.Keys, VideoCodecs.Baseline, Host, TestIdentity.Sig));
        await Task.WhenAll(Enumerable.Range(0, count).Select(i => Task.Run(() =>
        {
            var connection = $"c{i}";
            var guest = _store.Enter(Room, connection, room => room.EnterLobby(connection, TestIdentity.Keys, VideoCodecs.Baseline, DateTimeOffset.UnixEpoch));
            _store.InRoom("host", (room, self) => room.Admit(self.Id, guest.Id, TestIdentity.Sig));
            if (i % 2 == 0)
                Assert.NotNull(_store.InAnyRoom(connection, room => room.Leave(connection) ?? throw new InvalidOperationException()));
        }, TestContext.Current.CancellationToken)));

        var members = _store.InRoom("host", (room, _) => room.Participants)!;
        Assert.Equal(count / 2 + 1, members.Count);
        Assert.Equal(count / 2 + 1, members.Select(p => p.Id).Distinct().Count());
    }
}
