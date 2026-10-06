using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Rtc.Queries.GetRtcConfig;
using Cipheroom.Domain.Rooms;
using NSubstitute;

namespace Cipheroom.Application.UnitTests.Rtc;

public sealed class GetRtcConfigQueryTests
{
    private readonly IRoomStore _rooms = Substitute.For<IRoomStore>();
    private readonly ILiveKitTokenIssuer _liveKit = Substitute.For<ILiveKitTokenIssuer>();
    private readonly IIceServerProvider _ice = Substitute.For<IIceServerProvider>();

    [Fact]
    public async Task Requires_joining_first()
    {
        var handler = new GetRtcConfigQueryHandler(_rooms, _liveKit, _ice);

        var error = await Assert.ThrowsAsync<NotFoundException>(async () =>
            await handler.Handle(new GetRtcConfigQuery("conn"), TestContext.Current.CancellationToken));

        Assert.Equal("Join a room first.", error.Message);
        _liveKit.DidNotReceiveWithAnyArgs().Issue(default!);
    }

    [Fact]
    public async Task Combines_livekit_access_and_ice_servers_for_the_participant()
    {
        var self = new Participant(ParticipantId.New(), new RoomId("room-1"), "conn", new DisplayName("Alice"));
        _rooms.FindByConnection("conn").Returns(self);
        _liveKit.Issue(self).Returns(new LiveKitAccess("wss://x/livekit", "jwt"));
        IceServer[] servers = [new(["turn:x"], "u", "p")];
        _ice.GetAsync(self.Id, Arg.Any<CancellationToken>()).Returns(new IceConfig(servers, ForceRelay: true));

        var result = await new GetRtcConfigQueryHandler(_rooms, _liveKit, _ice)
            .Handle(new GetRtcConfigQuery("conn"), TestContext.Current.CancellationToken);

        Assert.Equal(new RtcConfigResult("wss://x/livekit", "jwt", servers, true), result);
    }
}
