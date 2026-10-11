using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;
using Cipheroom.Infrastructure.Rtc;

namespace Cipheroom.Infrastructure.IntegrationTests.Rtc;

public sealed class CloudflareMediaRoomTests
{
    private static readonly RoomId Room = new("k3fqz2abcdefghijklmnopqrst");
    private readonly RecordingSfu _sfu = new();
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    [Fact]
    public void Is_the_cloudflare_provider() => Assert.Equal(MediaProvider.Cloudflare, new CloudflareMediaRoom(_sfu).Provider);

    [Fact]
    public async Task Removing_someone_closes_what_their_session_sends_and_receives()
    {
        var bob = Bob() with
        {
            SfuSessionId = "sess-b",
            Tracks = [new PublishedTrack("t-cam", TrackSource.Camera, "7")],
            Subscriptions = [new Subscription("3", ParticipantId.New(), TrackSource.Camera), new Subscription("7", ParticipantId.New(), TrackSource.Microphone)],
        };

        await new CloudflareMediaRoom(_sfu).RemoveParticipantAsync(Room, bob, _ct);

        var (session, mids) = Assert.Single(_sfu.Closed);
        Assert.Equal("sess-b", session);
        Assert.Equal(["3", "7"], mids);
    }

    [Fact]
    public async Task Nothing_to_close_without_a_session_or_tracks()
    {
        await new CloudflareMediaRoom(_sfu).RemoveParticipantAsync(Room, Bob(), _ct);
        await new CloudflareMediaRoom(_sfu).RemoveParticipantAsync(Room, Bob() with { SfuSessionId = "sess-b" }, _ct);

        Assert.Empty(_sfu.Closed);
    }

    [Fact]
    public async Task Ending_the_call_leaves_the_sessions_to_expire()
    {
        await new CloudflareMediaRoom(_sfu).EndRoomAsync(Room, _ct);

        Assert.Empty(_sfu.Closed);
    }

    private static Participant Bob() => new(ParticipantId.New(), Room, "bob", TestIdentity.Keys);

    private sealed class RecordingSfu : ISfu
    {
        public List<(string Session, IReadOnlyList<string> Mids)> Closed { get; } = [];

        public Task CloseTracksAsync(string sessionId, IReadOnlyList<string> mids, CancellationToken cancellationToken)
        {
            Closed.Add((sessionId, mids));
            return Task.CompletedTask;
        }

        public Task<string> CreateSessionAsync(CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<string> PublishAsync(string sessionId, string offerSdp, IReadOnlyList<SfuLocalTrack> tracks, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<SfuSubscribeResult> SubscribeAsync(string sessionId, IReadOnlyList<SfuRemoteTrack> tracks, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task RenegotiateAsync(string sessionId, string answerSdp, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<string> RestartIceAsync(string sessionId, string offerSdp, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task SelectLayerAsync(string sessionId, string mid, SfuRemoteTrack track, string rid, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<SfuDataTransport> EstablishDataTransportAsync(string sessionId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<int> PublishDataChannelAsync(string sessionId, string name, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<int> SubscribeDataChannelAsync(string sessionId, string publisherSessionId, string name, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task CloseDataChannelsAsync(string sessionId, IReadOnlyList<int> ids, CancellationToken cancellationToken) => throw new NotSupportedException();
    }
}
