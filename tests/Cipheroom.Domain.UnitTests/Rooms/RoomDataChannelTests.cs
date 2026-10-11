using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Domain.UnitTests.Rooms;

/// <summary>Data channels for encrypted file transfers (docs/plans/2026-10-10-encrypted-files-design.md).</summary>
public sealed class RoomDataChannelTests
{
    private const string Name = "AAAAAAAAAAAAAAAAAAAAAA";
    private static readonly DateTimeOffset T0 = DateTimeOffset.UnixEpoch;

    private readonly Room _room = new(TestRooms.Id1);
    private readonly Participant _alice;
    private readonly Participant _bob;

    public RoomDataChannelTests()
    {
        _alice = WithTransport("conn-a", "sess-a");
        _bob = WithTransport("conn-b", "sess-b");
    }

    [Fact]
    public void Data_channels_need_the_data_transport_once()
    {
        var carol = _room.AttachSfuSession(_room.Join("conn-c").Id, "sess-c");

        Assert.Equal(Room.NoDataTransport, Assert.Throws<DomainException>(() => _room.EnsureCanPublishDataChannel(carol.Id, Name)).Message);
        _room.AttachDataTransport(carol.Id);
        Assert.Equal(Room.DataTransportAlreadyOpen, Assert.Throws<DomainException>(() => _room.AttachDataTransport(carol.Id)).Message);
    }

    [Fact]
    public void Published_channels_are_named_on_the_media_server_by_owner()
    {
        var channel = _room.PublishDataChannel(_alice.Id, Name, 3, T0);

        Assert.Equal(new DataChannel(Name, 3, null, T0), channel);
        Assert.Equal(channel, Assert.Single(_room.Find(_alice.Id)!.DataChannels));
        var remote = _room.ResolveDataChannel(_bob.Id, _alice.Id, Name);
        Assert.Equal(new RemoteDataChannel(_alice.Id, "sess-a", $"{_alice.Id}-{Name}"), remote);
    }

    [Fact]
    public void A_participant_publishes_at_most_four_channels_with_distinct_names()
    {
        _room.PublishDataChannel(_bob.Id, Name, 1, T0);
        Assert.Equal(Room.InvalidDataChannel, Assert.Throws<DomainException>(() => _room.PublishDataChannel(_bob.Id, Name, 2, T0)).Message);

        for (var i = 0; i < Room.MaxPublishedDataChannels; i++)
            _room.PublishDataChannel(_alice.Id, NameFor(i), i, T0);
        Assert.Equal(Room.TooManyDataChannels, Assert.Throws<DomainException>(() => _room.PublishDataChannel(_alice.Id, Name, 9, T0)).Message);
    }

    [Fact]
    public void Only_channels_someone_else_in_the_room_published_can_be_received()
    {
        _room.PublishDataChannel(_alice.Id, Name, 3, T0);
        var other = new Room(TestRooms.Id2);
        var mallory = other.AttachSfuSession(other.Join("conn-m").Id, "sess-m");
        other.AttachDataTransport(mallory.Id);

        Assert.Throws<DomainException>(() => _room.ResolveDataChannel(_alice.Id, _alice.Id, Name));
        Assert.Throws<DomainException>(() => _room.ResolveDataChannel(_bob.Id, _alice.Id, "BBBBBBBBBBBBBBBBBBBBBB"));
        Assert.Throws<DomainException>(() => other.ResolveDataChannel(mallory.Id, _alice.Id, Name));
    }

    [Fact]
    public void A_channel_is_received_once_and_at_most_eight_at_a_time()
    {
        _room.PublishDataChannel(_alice.Id, Name, 3, T0);
        Assert.NotNull(_room.SubscribeDataChannel(_bob.Id, _alice.Id, Name, 7, T0));
        Assert.Throws<DomainException>(() => _room.ResolveDataChannel(_bob.Id, _alice.Id, Name));

        var carol = WithTransport("conn-c", "sess-c");
        var dave = WithTransport("conn-d", "sess-d");
        for (var i = 0; i < Room.MaxPublishedDataChannels; i++)
        {
            _room.PublishDataChannel(carol.Id, NameFor(i), i, T0);
            _room.PublishDataChannel(dave.Id, NameFor(i), i, T0);
        }

        var wanted = Enumerable.Range(0, Room.MaxPublishedDataChannels).SelectMany(i => new[] { (carol.Id, NameFor(i)), (dave.Id, NameFor(i)) }).ToArray();
        foreach (var (publisher, name) in wanted[..(Room.MaxSubscribedDataChannels - 1)])
        {
            _room.ResolveDataChannel(_bob.Id, publisher, name);
            _room.SubscribeDataChannel(_bob.Id, publisher, name, 10, T0);
        }

        var (lastPublisher, lastName) = wanted[Room.MaxSubscribedDataChannels - 1];
        Assert.Equal(Room.TooManyDataChannels, Assert.Throws<DomainException>(() => _room.ResolveDataChannel(_bob.Id, lastPublisher, lastName)).Message);
    }

    [Fact]
    public void Subscribing_to_a_channel_closed_meanwhile_records_nothing()
    {
        Assert.Null(_room.SubscribeDataChannel(_bob.Id, _alice.Id, Name, 7, T0));
        Assert.Empty(_room.Find(_bob.Id)!.DataChannels);
    }

    [Fact]
    public void Closing_a_published_channel_closes_everyone_s_subscriptions_to_it()
    {
        _room.PublishDataChannel(_alice.Id, Name, 3, T0);
        _room.SubscribeDataChannel(_bob.Id, _alice.Id, Name, 7, T0);

        var closures = _room.CloseDataChannel(_alice.Id, Name, publisherId: null);

        Assert.Equal([new DataChannelClosure("sess-a", 3), new DataChannelClosure("sess-b", 7)], closures);
        Assert.Empty(_room.Find(_alice.Id)!.DataChannels);
        Assert.Empty(_room.Find(_bob.Id)!.DataChannels);
        Assert.Empty(_room.CloseDataChannel(_alice.Id, Name, publisherId: null));
    }

    [Fact]
    public void Closing_a_subscription_leaves_the_publisher_s_channel()
    {
        _room.PublishDataChannel(_alice.Id, Name, 3, T0);
        _room.SubscribeDataChannel(_bob.Id, _alice.Id, Name, 7, T0);

        Assert.Equal([new DataChannelClosure("sess-b", 7)], _room.CloseDataChannel(_bob.Id, Name, _alice.Id));
        Assert.Single(_room.Find(_alice.Id)!.DataChannels);
    }

    [Fact]
    public void Channels_older_than_the_cut_off_are_closed()
    {
        _room.PublishDataChannel(_alice.Id, Name, 3, T0);
        _room.SubscribeDataChannel(_bob.Id, _alice.Id, Name, 7, T0.AddMinutes(1));
        _room.PublishDataChannel(_bob.Id, Name, 8, T0.AddMinutes(2));

        var closures = _room.CloseDataChannelsOpenedBefore(T0);

        Assert.Equal([new DataChannelClosure("sess-a", 3), new DataChannelClosure("sess-b", 7)], closures);
        Assert.Equal(8, Assert.Single(_room.Find(_bob.Id)!.DataChannels).Id);
    }

    [Fact]
    public void Leaving_drops_what_others_received_from_the_leaver()
    {
        _room.PublishDataChannel(_alice.Id, Name, 3, T0);
        _room.SubscribeDataChannel(_bob.Id, _alice.Id, Name, 7, T0);

        _room.Leave("conn-a");

        Assert.Empty(_room.Find(_bob.Id)!.DataChannels);
    }

    private static string NameFor(int i) => Name[..21] + i;

    private Participant WithTransport(string connectionId, string sessionId)
    {
        var participant = _room.AttachSfuSession(_room.Join(connectionId).Id, sessionId);
        return _room.AttachDataTransport(participant.Id);
    }
}
