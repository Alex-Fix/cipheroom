using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Files;
using Cipheroom.Application.Files.Commands.CloseDataChannel;
using Cipheroom.Application.Files.Commands.CloseExpiredDataChannels;
using Cipheroom.Application.Files.Commands.OpenDataTransport;
using Cipheroom.Application.Files.Commands.PublishDataChannel;
using Cipheroom.Application.Files.Commands.SubscribeDataChannel;
using Cipheroom.Application.UnitTests.Common;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;

namespace Cipheroom.Application.UnitTests.Files;

public sealed class DataChannelCommandTests
{
    private const string Name = "AAAAAAAAAAAAAAAAAAAAAA";

    private readonly FakeRoomStore _rooms = new();
    private readonly ISfu _sfu = Substitute.For<ISfu>();
    private readonly FakeUsageGuard _usage = new();
    private readonly FakeTimeProvider _time = new();
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    [Fact]
    public async Task Opening_the_transport_creates_a_session_if_needed_and_returns_the_sfu_offer()
    {
        _rooms.Join("conn-a");
        _sfu.CreateSessionAsync(_ct).Returns("sess-a");
        _sfu.EstablishDataTransportAsync("sess-a", _ct).Returns(new SfuDataTransport("v=0 offer", 0));

        var result = await OpenTransport("conn-a");

        Assert.Equal(new OpenDataTransportResult("v=0 offer", 0), result);
        Assert.True(_rooms.FindByConnection("conn-a")!.HasDataTransport);
        var again = await Assert.ThrowsAsync<DomainException>(() => OpenTransport("conn-a"));
        Assert.Equal(Room.DataTransportAlreadyOpen, again.Message);
    }

    [Fact]
    public async Task Publishing_uses_the_owner_prefixed_name_and_records_the_channel()
    {
        var alice = await WithTransport("conn-a", "sess-a");
        _sfu.PublishDataChannelAsync("sess-a", $"{alice.Id}-{Name}", _ct).Returns(3);

        var result = await new PublishDataChannelCommandHandler(_rooms, _sfu, _usage, _time, Metrics()).Handle(new("conn-a", Name), _ct);

        Assert.Equal(3, result.ChannelId);
        Assert.Equal(new DataChannel(Name, 3, null, _time.GetUtcNow()), Assert.Single(_rooms.FindByConnection("conn-a")!.DataChannels));
    }

    [Fact]
    public async Task Publishing_without_the_transport_fails_before_the_media_server()
    {
        _rooms.Join("conn-a", sfuSessionId: "sess-a");

        var ex = await Assert.ThrowsAsync<DomainException>(() => Publish("conn-a"));

        Assert.Equal(Room.NoDataTransport, ex.Message);
        Assert.Empty(_sfu.ReceivedCalls());
    }

    [Theory]
    [InlineData(UsageLevel.AudioOnly)]
    [InlineData(UsageLevel.Paused)]
    public async Task File_sharing_pauses_with_the_usage_guard(UsageLevel level)
    {
        var alice = await WithTransport("conn-a", "sess-a");
        await Publish("conn-a");
        await WithTransport("conn-b", "sess-b");
        _usage.Level = level;
        _sfu.ClearReceivedCalls();

        Assert.Equal(FileRules.FileSharingPaused, (await Assert.ThrowsAsync<DomainException>(() => Publish("conn-b"))).Message);
        Assert.Equal(FileRules.FileSharingPaused, (await Assert.ThrowsAsync<DomainException>(() => Subscribe("conn-b", alice.Id))).Message);
        Assert.Empty(_sfu.ReceivedCalls());
    }

    [Fact]
    public async Task Subscribing_pulls_the_publisher_s_session_and_channel()
    {
        var alice = await WithTransport("conn-a", "sess-a");
        await Publish("conn-a");
        await WithTransport("conn-b", "sess-b");
        _sfu.SubscribeDataChannelAsync("sess-b", "sess-a", $"{alice.Id}-{Name}", _ct).Returns(7);

        var result = await Subscribe("conn-b", alice.Id);

        Assert.Equal(7, result.ChannelId);
        Assert.Equal(new DataChannel(Name, 7, alice.Id, _time.GetUtcNow()), Assert.Single(_rooms.FindByConnection("conn-b")!.DataChannels));
    }

    [Fact]
    public async Task A_channel_closed_while_subscribing_is_closed_again_on_the_media_server()
    {
        var alice = await WithTransport("conn-a", "sess-a");
        await Publish("conn-a");
        await WithTransport("conn-b", "sess-b");
        _sfu.SubscribeDataChannelAsync("sess-b", "sess-a", Arg.Any<string>(), _ct).Returns(_ =>
        {
            _rooms.InRoom("conn-a", (room, p) => room.CloseDataChannel(p.Id, Name, null));
            return 7;
        });

        var ex = await Assert.ThrowsAsync<DomainException>(() => Subscribe("conn-b", alice.Id));

        Assert.Equal(Room.InvalidDataChannel, ex.Message);
        await _sfu.Received(1).CloseDataChannelsAsync("sess-b", Ids(7), _ct);
    }

    [Fact]
    public async Task Closing_an_own_channel_closes_subscribers_too()
    {
        var alice = await WithTransport("conn-a", "sess-a");
        _sfu.PublishDataChannelAsync(Arg.Any<string>(), Arg.Any<string>(), _ct).Returns(3);
        await Publish("conn-a");
        await WithTransport("conn-b", "sess-b");
        _sfu.SubscribeDataChannelAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string>(), _ct).Returns(7);
        await Subscribe("conn-b", alice.Id);

        await new CloseDataChannelCommandHandler(_rooms, _sfu).Handle(new("conn-a", Name, null), _ct);

        await _sfu.Received(1).CloseDataChannelsAsync("sess-a", Ids(3), _ct);
        await _sfu.Received(1).CloseDataChannelsAsync("sess-b", Ids(7), _ct);
    }

    [Fact]
    public async Task Channels_expire_after_the_lifetime()
    {
        await WithTransport("conn-a", "sess-a");
        _sfu.PublishDataChannelAsync(Arg.Any<string>(), Arg.Any<string>(), _ct).Returns(3);
        await Publish("conn-a");
        var handler = new CloseExpiredDataChannelsCommandHandler(_rooms, _sfu, _time, Metrics());

        _time.Advance(FileRules.ChannelLifetime - TimeSpan.FromSeconds(1));
        Assert.Equal(0, await handler.Handle(new(), _ct));

        _time.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(1, await handler.Handle(new(), _ct));
        await _sfu.Received(1).CloseDataChannelsAsync("sess-a", Ids(3), _ct);
        Assert.Empty(_rooms.FindByConnection("conn-a")!.DataChannels);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("short")]
    [InlineData("AAAAAAAAAAAAAAAAAAAAA/")]
    [InlineData("AAAAAAAAAAAAAAAAAAAAAAA")]
    public void Channel_names_are_22_base64url_characters(string? name) =>
        Assert.False(new PublishDataChannelCommandValidator().Validate(new PublishDataChannelCommand("conn-a", name)).IsValid);

    private Task<OpenDataTransportResult> OpenTransport(string connectionId) =>
        new OpenDataTransportCommandHandler(_rooms, _sfu).Handle(new(connectionId), _ct).AsTask();

    private Task<DataChannelResult> Publish(string connectionId) =>
        new PublishDataChannelCommandHandler(_rooms, _sfu, _usage, _time, Metrics()).Handle(new(connectionId, Name), _ct).AsTask();

    private Task<DataChannelResult> Subscribe(string connectionId, ParticipantId publisher) =>
        new SubscribeDataChannelCommandHandler(_rooms, _sfu, _usage, _time, Metrics()).Handle(new(connectionId, publisher.Value, Name), _ct).AsTask();

    private async Task<Participant> WithTransport(string connectionId, string sessionId)
    {
        _rooms.Join(connectionId, sfuSessionId: sessionId);
        _sfu.EstablishDataTransportAsync(sessionId, _ct).Returns(new SfuDataTransport("v=0 offer", 0));
        await OpenTransport(connectionId);
        return _rooms.FindByConnection(connectionId)!;
    }

    private static IReadOnlyList<int> Ids(int id) => Arg.Is<IReadOnlyList<int>>(ids => ids.Count == 1 && ids[0] == id);

    private Application.Common.Telemetry.CipheroomMetrics Metrics() => TestMetrics.Create(_rooms).Metrics;
}
