using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Domain.UnitTests.Rooms;

public sealed class RoomMediaTests
{
    private readonly Room _room = new(new RoomId("room-1"));
    private readonly Participant _alice;
    private readonly Participant _bob;

    public RoomMediaTests()
    {
        _alice = Joined("conn-a", "Alice", "sess-a");
        _bob = Joined("conn-b", "Bob", "sess-b");
    }

    [Fact]
    public void Publish_names_tracks_on_the_server_and_derives_their_kind()
    {
        var tracks = _room.Publish(_alice.Id, [(TrackSource.Microphone, "0"), (TrackSource.Camera, "1")]);

        Assert.Equal([$"{_alice.Id}-microphone", $"{_alice.Id}-camera"], tracks.Select(t => t.Name));
        Assert.Equal([TrackKind.Audio, TrackKind.Video], tracks.Select(t => t.Kind));
        Assert.Equal(tracks, _room.Find(_alice.Id)!.Tracks);
    }

    [Fact]
    public void A_source_can_only_be_published_once()
    {
        _room.Publish(_alice.Id, [(TrackSource.Camera, "1")]);

        var ex = Assert.Throws<DomainException>(() => _room.Publish(_alice.Id, [(TrackSource.Camera, "2")]));
        Assert.Equal("Track already published.", ex.Message);
        Assert.Throws<DomainException>(() => _room.EnsureCanPublish(_bob.Id, [TrackSource.Screen, TrackSource.Screen]));
    }

    [Fact]
    public void Publishing_requires_a_media_session()
    {
        var carol = _room.Join("conn-c", new DisplayName("Carol"), TestIdentity.Keys);
        Assert.Throws<InvalidOperationException>(() => _room.Publish(carol.Id, [(TrackSource.Camera, "0")]));
    }

    [Fact]
    public void An_existing_media_session_is_never_replaced()
    {
        Assert.Equal("sess-a", _room.AttachSfuSession(_alice.Id, "other").SfuSessionId);
    }

    [Fact]
    public void Subscribing_resolves_tracks_of_others_in_the_room_and_skips_known_ones()
    {
        _room.Publish(_alice.Id, [(TrackSource.Camera, "1")]);

        var remote = Assert.Single(_room.ResolveForSubscribe(_bob.Id, [(_alice.Id, TrackSource.Camera)]));
        Assert.Equal(new RemoteTrack(_alice.Id, "sess-a", _room.Find(_alice.Id)!.Tracks[0]), remote);

        _room.Subscribe(_bob.Id, [new Subscription("5", _alice.Id, TrackSource.Camera)]);
        Assert.Empty(_room.ResolveForSubscribe(_bob.Id, [(_alice.Id, TrackSource.Camera)]));
        Assert.Equal(remote, _room.FindSubscription(_bob.Id, "5"));
    }

    [Fact]
    public void Unknown_own_or_foreign_tracks_cannot_be_subscribed()
    {
        _room.Publish(_alice.Id, [(TrackSource.Camera, "1")]);
        var stranger = new Room(new RoomId("room-2")).Join("conn-x", new DisplayName("X"), TestIdentity.Keys);

        foreach (var (who, source) in new[] { (_alice.Id, TrackSource.Screen), (_bob.Id, TrackSource.Camera), (stranger.Id, TrackSource.Camera) })
        {
            var ex = Assert.Throws<DomainException>(() => _room.ResolveForSubscribe(_bob.Id, [(who, source)]));
            Assert.Equal(Room.UnknownTrack, ex.Message);
        }

        // Your own track is not something you subscribe to.
        Assert.Throws<DomainException>(() => _room.ResolveForSubscribe(_alice.Id, [(_alice.Id, TrackSource.Camera)]));
    }

    [Fact]
    public void Unpublishing_drops_everyone_s_subscriptions_to_that_track()
    {
        _room.Publish(_alice.Id, [(TrackSource.Microphone, "0"), (TrackSource.Camera, "1")]);
        _room.Subscribe(_bob.Id, [new Subscription("5", _alice.Id, TrackSource.Microphone), new Subscription("6", _alice.Id, TrackSource.Camera)]);

        var removed = _room.Unpublish(_alice.Id, [TrackSource.Camera, TrackSource.Screen]);

        Assert.Equal([TrackSource.Camera], removed.Select(t => t.Source));
        Assert.Equal(["5"], _room.Find(_bob.Id)!.Subscriptions.Select(s => s.Mid));
        Assert.Throws<DomainException>(() => _room.FindSubscription(_bob.Id, "6"));
    }

    [Fact]
    public void Leaving_drops_everyone_s_subscriptions_to_the_leaver()
    {
        _room.Publish(_alice.Id, [(TrackSource.Camera, "1")]);
        _room.Subscribe(_bob.Id, [new Subscription("5", _alice.Id, TrackSource.Camera)]);

        _room.Leave("conn-a");

        Assert.Empty(_room.Find(_bob.Id)!.Subscriptions);
    }

    [Fact]
    public void Subscriptions_to_tracks_that_went_away_are_not_recorded()
    {
        _room.Subscribe(_bob.Id, [new Subscription("5", _alice.Id, TrackSource.Camera)]);
        Assert.Empty(_room.Find(_bob.Id)!.Subscriptions);
    }

    [Fact]
    public void Unsubscribe_removes_by_mid_and_ignores_unknown_mids()
    {
        _room.Publish(_alice.Id, [(TrackSource.Camera, "1")]);
        _room.Subscribe(_bob.Id, [new Subscription("5", _alice.Id, TrackSource.Camera)]);

        Assert.Equal(["5"], _room.Unsubscribe(_bob.Id, ["5", "9"]).Select(s => s.Mid));
        Assert.Empty(_room.Find(_bob.Id)!.Subscriptions);
    }

    [Fact]
    public void Mute_state_is_kept_per_track()
    {
        _room.Publish(_alice.Id, [(TrackSource.Microphone, "0")]);

        Assert.True(_room.SetMuted(_alice.Id, TrackSource.Microphone, true).Muted);
        Assert.True(_room.Find(_alice.Id)!.Track(TrackSource.Microphone)!.Muted);
        Assert.Throws<DomainException>(() => _room.SetMuted(_alice.Id, TrackSource.Camera, true));
    }

    [Theory]
    [InlineData("microphone", true)]
    [InlineData("camera", true)]
    [InlineData("screen", true)]
    [InlineData("Camera", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void Track_sources_parse_only_their_wire_names(string? value, bool valid) =>
        Assert.Equal(valid, TrackSources.IsValid(value));

    private Participant Joined(string connectionId, string name, string sessionId) =>
        _room.AttachSfuSession(_room.Join(connectionId, new DisplayName(name), TestIdentity.Keys).Id, sessionId);
}
