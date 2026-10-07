using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Media;
using Cipheroom.Application.Media.Commands.PublishTracks;
using Cipheroom.Application.Media.Commands.Renegotiate;
using Cipheroom.Application.Media.Commands.SelectVideoLayer;
using Cipheroom.Application.Media.Commands.SetTrackMuted;
using Cipheroom.Application.Media.Commands.SubscribeTracks;
using Cipheroom.Application.Media.Commands.UnpublishTracks;
using Cipheroom.Application.UnitTests.Common;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;
using NSubstitute;

namespace Cipheroom.Application.UnitTests.Media;

public sealed class MediaCommandTests
{
    private const string Offer = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n";

    private readonly FakeRoomStore _rooms = new();
    private readonly ISfu _sfu = Substitute.For<ISfu>();
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    [Fact]
    public async Task First_publish_creates_a_session_and_publishes_under_server_names()
    {
        var alice = _rooms.Join("conn-a");
        _sfu.CreateSessionAsync(_ct).Returns("sess-a");
        _sfu.PublishAsync("sess-a", Offer, Arg.Any<IReadOnlyList<SfuLocalTrack>>(), _ct).Returns("answer");

        var result = await Publish("conn-a", ("0", "microphone"), ("1", "camera"));

        Assert.Equal("answer", result.AnswerSdp);
        Assert.Equal("sess-a", result.Self.SfuSessionId);
        Assert.Equal([TrackSource.Microphone, TrackSource.Camera], result.Self.Tracks.Select(t => t.Source));
        await _sfu.Received(1).PublishAsync("sess-a", Offer,
            Arg.Is<IReadOnlyList<SfuLocalTrack>>(t => t.SequenceEqual(new[]
            {
                new SfuLocalTrack("0", $"{alice.Id}-microphone"),
                new SfuLocalTrack("1", $"{alice.Id}-camera"),
            })),
            _ct);
    }

    [Fact]
    public async Task Later_publishes_reuse_the_session()
    {
        _rooms.Join("conn-a", sfuSessionId: "sess-a");

        await Publish("conn-a", ("2", "screen"));

        await _sfu.DidNotReceiveWithAnyArgs().CreateSessionAsync(_ct);
    }

    [Fact]
    public async Task Republishing_a_source_is_rejected_before_calling_the_media_server()
    {
        _rooms.Join("conn-a", sfuSessionId: "sess-a");
        await Publish("conn-a", ("1", "camera"));
        _sfu.ClearReceivedCalls();

        var ex = await Assert.ThrowsAsync<DomainException>(() => Publish("conn-a", ("3", "camera")));

        Assert.Equal("Track already published.", ex.Message);
        Assert.Empty(_sfu.ReceivedCalls());
    }

    [Fact]
    public async Task Publishing_outside_a_room_is_not_found()
    {
        var ex = await Assert.ThrowsAsync<NotFoundException>(() => Publish("nobody", ("0", "camera")));
        Assert.Equal(MediaRules.NotInRoom, ex.Message);
    }

    [Fact]
    public async Task Subscribe_pulls_room_tracks_and_returns_the_receiving_mids()
    {
        var alice = await Publisher("conn-a", "sess-a", ("0", "microphone"), ("1", "camera"));
        _rooms.Join("conn-b", sfuSessionId: "sess-b");
        _sfu.SubscribeAsync("sess-b", Arg.Any<IReadOnlyList<SfuRemoteTrack>>(), _ct).Returns(new SfuSubscribeResult("offer",
        [
            new SfuPulledTrack("sess-a", $"{alice.Id}-camera", "7"),
            new SfuPulledTrack("sess-a", $"{alice.Id}-microphone", "6"),
        ]));

        var result = await Subscribe("conn-b", (alice.Id.Value, "microphone"), (alice.Id.Value, "camera"));

        Assert.Equal("offer", result.OfferSdp);
        Assert.Equal(
            [new SubscribedTrack(alice.Id, TrackSource.Camera, "7"), new SubscribedTrack(alice.Id, TrackSource.Microphone, "6")],
            result.Tracks);
        // Only the camera is pulled with simulcast.
        await _sfu.Received(1).SubscribeAsync("sess-b",
            Arg.Is<IReadOnlyList<SfuRemoteTrack>>(t => t.SequenceEqual(new[]
            {
                new SfuRemoteTrack("sess-a", $"{alice.Id}-microphone", false),
                new SfuRemoteTrack("sess-a", $"{alice.Id}-camera", true),
            })),
            _ct);
        Assert.Equal(["7", "6"], _rooms.RoomOf("conn-b").Find(_rooms.FindByConnection("conn-b")!.Id)!.Subscriptions.Select(s => s.Mid));
    }

    [Fact]
    public async Task Subscribing_again_to_the_same_tracks_does_nothing()
    {
        var alice = await Publisher("conn-a", "sess-a", ("1", "camera"));
        _rooms.Join("conn-b", sfuSessionId: "sess-b");
        _sfu.SubscribeAsync("sess-b", Arg.Any<IReadOnlyList<SfuRemoteTrack>>(), _ct)
            .Returns(new SfuSubscribeResult("offer", [new SfuPulledTrack("sess-a", $"{alice.Id}-camera", "7")]));
        await Subscribe("conn-b", (alice.Id.Value, "camera"));
        _sfu.ClearReceivedCalls();

        Assert.Same(SubscribeTracksResult.Nothing, await Subscribe("conn-b", (alice.Id.Value, "camera")));
        Assert.Empty(_sfu.ReceivedCalls());
    }

    [Fact]
    public async Task Tracks_from_another_room_are_unknown_and_never_reach_the_media_server()
    {
        var mallory = await Publisher("conn-m", "sess-m", ("1", "camera"), room: "other-room");
        _rooms.Join("conn-b", sfuSessionId: "sess-b");
        _sfu.ClearReceivedCalls();

        var ex = await Assert.ThrowsAsync<DomainException>(() => Subscribe("conn-b", (mallory.Id.Value, "camera")));

        Assert.Equal(Room.UnknownTrack, ex.Message);
        Assert.Empty(_sfu.ReceivedCalls());
    }

    [Fact]
    public async Task Renegotiate_needs_an_existing_media_session()
    {
        _rooms.Join("conn-a");

        var ex = await Assert.ThrowsAsync<DomainException>(async () =>
            await new RenegotiateCommandHandler(_rooms, _sfu).Handle(new RenegotiateCommand("conn-a", Offer), _ct));

        Assert.Equal(MediaRules.NoMediaSession, ex.Message);
    }

    [Fact]
    public async Task Unpublish_removes_tracks_and_closes_them_by_mid()
    {
        await Publisher("conn-a", "sess-a", ("0", "microphone"), ("2", "screen"));

        var result = await new UnpublishTracksCommandHandler(_rooms, _sfu)
            .Handle(new UnpublishTracksCommand("conn-a", ["screen"]), _ct);

        Assert.Equal([TrackSource.Screen], result.Removed.Select(t => t.Source));
        Assert.Equal([TrackSource.Microphone], result.Self.Tracks.Select(t => t.Source));
        await _sfu.Received(1).CloseTracksAsync("sess-a", Arg.Is<IReadOnlyList<string>>(m => m.Count == 1 && m[0] == "2"), _ct);
    }

    [Fact]
    public async Task Mute_state_is_recorded_on_the_track()
    {
        await Publisher("conn-a", "sess-a", ("0", "microphone"));

        var result = await new SetTrackMutedCommandHandler(_rooms).Handle(new SetTrackMutedCommand("conn-a", "microphone", true), _ct);

        Assert.True(result.Track.Muted);
        Assert.True(result.Self.Track(TrackSource.Microphone)!.Muted);
    }

    [Fact]
    public async Task Layer_selection_targets_the_publisher_track_of_a_camera_subscription()
    {
        var alice = await Publisher("conn-a", "sess-a", ("0", "microphone"), ("1", "camera"));
        _rooms.Join("conn-b", sfuSessionId: "sess-b");
        _rooms.InRoom("conn-b", (room, bob) =>
        {
            room.Subscribe(bob.Id, [new Subscription("6", alice.Id, TrackSource.Microphone), new Subscription("7", alice.Id, TrackSource.Camera)]);
            return bob;
        });
        var handler = new SelectVideoLayerCommandHandler(_rooms, _sfu);

        await handler.Handle(new SelectVideoLayerCommand("conn-b", "7", "q"), _ct);

        await _sfu.Received(1).SelectLayerAsync("sess-b", "7", new SfuRemoteTrack("sess-a", $"{alice.Id}-camera", true), "q", _ct);
        // Audio has no layers.
        await Assert.ThrowsAsync<DomainException>(async () => await handler.Handle(new SelectVideoLayerCommand("conn-b", "6", "q"), _ct));
    }

    // Validators

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("<script>")]
    public void Publish_rejects_anything_that_is_not_an_sdp(string? sdp) =>
        Assert.Equal([MediaRules.InvalidSdp], Messages(new PublishTracksCommand("conn", sdp, [new("0", "camera")])));

    [Fact]
    public void Publish_rejects_oversized_sdp() =>
        Assert.Equal([MediaRules.InvalidSdp],
            Messages(new PublishTracksCommand("conn", "v=0" + new string('a', MediaRules.MaxSdpLength), [new("0", "camera")])));

    [Fact]
    public void Publish_requires_a_track_list() =>
        Assert.Equal([MediaRules.InvalidTrack], Messages(new PublishTracksCommand("conn", Offer, null)));

    public static TheoryData<PublishTrackInput[]> BadTrackLists => new()
    {
        Array.Empty<PublishTrackInput>(),
        new PublishTrackInput[] { new("0", "microphone"), new("1", "camera"), new("2", "screen"), new("3", "camera") },
        new PublishTrackInput[] { new("0", "camera"), new("1", "camera") },
        new PublishTrackInput[] { new("0", "camera"), new("0", "screen") },
        new PublishTrackInput[] { new("0", "speaker") },
        new PublishTrackInput[] { new("../x", "camera") },
        new PublishTrackInput[] { new(null, "camera") },
    };

    [Theory]
    [MemberData(nameof(BadTrackLists))]
    public void Publish_rejects_bad_track_lists(PublishTrackInput[] tracks) =>
        Assert.Equal([MediaRules.InvalidTrack], Messages(new PublishTracksCommand("conn", Offer, tracks)));

    [Theory]
    [InlineData("not-an-id", "camera")]
    [InlineData("0123456789abcdef", "Camera")]
    [InlineData(null, "camera")]
    public void Subscribe_rejects_bad_track_references(string? participantId, string? source) =>
        Assert.Equal([MediaRules.InvalidTrack], Messages(new SubscribeTracksCommand("conn", [new(participantId, source)])));

    [Theory]
    [InlineData("x")]
    [InlineData("F")]
    [InlineData(null)]
    public void Layer_must_be_f_h_or_q(string? rid) =>
        Assert.Equal([MediaRules.InvalidLayer], Messages(new SelectVideoLayerCommand("conn", "7", rid)));

    [Fact]
    public void Messages_never_echo_the_input()
    {
        const string hostile = "<img src=x onerror=alert(1)>";
        Assert.All(
            Messages(new PublishTracksCommand("conn", hostile, [new(hostile, hostile)]))
                .Concat(Messages(new SubscribeTracksCommand("conn", [new(hostile, hostile)])))
                .Concat(Messages(new SelectVideoLayerCommand("conn", hostile, hostile))),
            m => Assert.DoesNotContain(hostile, m, StringComparison.Ordinal));
    }

    private Task<PublishTracksResult> Publish(string connectionId, params (string Mid, string Source)[] tracks) =>
        new PublishTracksCommandHandler(_rooms, _sfu)
            .Handle(new PublishTracksCommand(connectionId, Offer, [.. tracks.Select(t => new PublishTrackInput(t.Mid, t.Source))]), _ct)
            .AsTask();

    private Task<SubscribeTracksResult> Subscribe(string connectionId, params (string ParticipantId, string Source)[] tracks) =>
        new SubscribeTracksCommandHandler(_rooms, _sfu)
            .Handle(new SubscribeTracksCommand(connectionId, [.. tracks.Select(t => new SubscribeTrackInput(t.ParticipantId, t.Source))]), _ct)
            .AsTask();

    private async Task<Participant> Publisher(string connectionId, string sessionId, (string Mid, string Source) first, (string Mid, string Source)? second = null, string room = "room-1")
    {
        _rooms.Join(connectionId, room, sessionId);
        await Publish(connectionId, second is { } s ? [first, s] : [first]);
        return _rooms.FindByConnection(connectionId)!;
    }

    private static string[] Messages(PublishTracksCommand c) => Errors(new PublishTracksCommandValidator().Validate(c));

    private static string[] Messages(SubscribeTracksCommand c) => Errors(new SubscribeTracksCommandValidator().Validate(c));

    private static string[] Messages(SelectVideoLayerCommand c) => Errors(new SelectVideoLayerCommandValidator().Validate(c));

    private static string[] Errors(FluentValidation.Results.ValidationResult r) => [.. r.Errors.Select(e => e.ErrorMessage)];
}
