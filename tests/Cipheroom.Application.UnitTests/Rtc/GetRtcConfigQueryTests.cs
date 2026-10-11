using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Rtc.Queries.GetRtcConfig;
using Cipheroom.Application.UnitTests.Common;
using Cipheroom.Domain.Rooms;
using NSubstitute;

namespace Cipheroom.Application.UnitTests.Rtc;

public sealed class GetRtcConfigQueryTests
{
    private readonly IRoomStore _rooms = Substitute.For<IRoomStore>();
    private readonly IIceServerProvider _ice = Substitute.For<IIceServerProvider>();
    private readonly ISfu _sfu = Substitute.For<ISfu>();
    private readonly IMediaRoom _media = Substitute.For<IMediaRoom>();

    [Fact]
    public async Task Requires_joining_first()
    {
        var handler = new GetRtcConfigQueryHandler(_rooms, _ice, _sfu, _media);

        var error = await Assert.ThrowsAsync<NotFoundException>(async () =>
            await handler.Handle(new GetRtcConfigQuery("conn"), TestContext.Current.CancellationToken));

        Assert.Equal("Join a room first.", error.Message);
        await _ice.DidNotReceiveWithAnyArgs().GetAsync(default!, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task Returns_the_provider_and_the_ice_servers_for_the_participant()
    {
        var rooms = new FakeRoomStore();
        var self = rooms.Join("conn");
        IceServer[] servers = [new(["turn:x"], "u", "p")];
        _ice.GetAsync(self.Id, Arg.Any<CancellationToken>()).Returns(new IceConfig(servers, ForceRelay: true));
        _sfu.CreateSessionAsync(Arg.Any<CancellationToken>()).Returns("sess-1");
        _media.Provider.Returns(MediaProvider.Cloudflare);

        var result = await new GetRtcConfigQueryHandler(rooms, _ice, _sfu, _media)
            .Handle(new GetRtcConfigQuery("conn"), TestContext.Current.CancellationToken);

        Assert.Equal(new RtcConfigResult(MediaProvider.Cloudflare, servers, true), result);
    }

    [Fact]
    public async Task LiveKit_mode_names_the_provider_without_ice_servers_or_a_cloudflare_session()
    {
        var rooms = new FakeRoomStore();
        rooms.Join("conn");
        _media.Provider.Returns(MediaProvider.LiveKit);

        var result = await new GetRtcConfigQueryHandler(rooms, _ice, _sfu, _media).Handle(new GetRtcConfigQuery("conn"), TestContext.Current.CancellationToken);

        Assert.Equal(new RtcConfigResult(MediaProvider.LiveKit, [], false), result);
        await _ice.DidNotReceiveWithAnyArgs().GetAsync(default!, TestContext.Current.CancellationToken);
        await _sfu.DidNotReceiveWithAnyArgs().CreateSessionAsync(TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task Creates_the_media_session_ahead_of_the_first_publish()
    {
        var rooms = new FakeRoomStore();
        rooms.Join("conn");
        _ice.GetAsync(Arg.Any<ParticipantId>(), Arg.Any<CancellationToken>()).Returns(new IceConfig([], ForceRelay: false));
        _sfu.CreateSessionAsync(Arg.Any<CancellationToken>()).Returns("sess-1");

        await new GetRtcConfigQueryHandler(rooms, _ice, _sfu, _media).Handle(new GetRtcConfigQuery("conn"), TestContext.Current.CancellationToken);
        await new GetRtcConfigQueryHandler(rooms, _ice, _sfu, _media).Handle(new GetRtcConfigQuery("conn"), TestContext.Current.CancellationToken);

        Assert.Equal("sess-1", rooms.FindByConnection("conn")!.SfuSessionId);
        await _sfu.Received(1).CreateSessionAsync(Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task A_media_server_failure_still_returns_the_ice_servers()
    {
        var rooms = new FakeRoomStore();
        rooms.Join("conn");
        _ice.GetAsync(Arg.Any<ParticipantId>(), Arg.Any<CancellationToken>()).Returns(new IceConfig([], ForceRelay: false));
        _sfu.CreateSessionAsync(Arg.Any<CancellationToken>()).Returns(Task.FromException<string>(new MediaServerException()));

        var result = await new GetRtcConfigQueryHandler(rooms, _ice, _sfu, _media).Handle(new GetRtcConfigQuery("conn"), TestContext.Current.CancellationToken);

        Assert.Empty(result.IceServers);
        Assert.Null(rooms.FindByConnection("conn")!.SfuSessionId);
    }
}
