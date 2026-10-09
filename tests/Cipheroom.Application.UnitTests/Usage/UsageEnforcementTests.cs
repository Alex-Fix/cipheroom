using Cipheroom.Application.Admission.Commands.JoinLobby;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Media.Commands.SelectVideoLayer;
using Cipheroom.Application.Media.Commands.SubscribeTracks;
using Cipheroom.Application.UnitTests.Common;
using Cipheroom.Application.Usage.Commands.ApplyUsageLevel;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;

namespace Cipheroom.Application.UnitTests.Usage;

/// <summary>What the usage guard's levels do to joining, receiving and calls in progress (server-enforced).</summary>
public sealed class UsageEnforcementTests
{
    private static readonly string[] VideoMids = ["7", "8"];
    private static readonly string[] AudioMids = ["6"];
    private static readonly HostProofInput HostProof = new(TestIdentity.Ed25519Pub, TestIdentity.X25519Pub, TestIdentity.Sig);

    private readonly FakeRoomStore _rooms = new();
    private readonly FakeUsageGuard _usage = new();
    private readonly ISfu _sfu = Substitute.For<ISfu>();
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    [Theory]
    [InlineData(UsageLevel.AudioOnly)]
    [InlineData(UsageLevel.Paused)]
    public async Task No_new_call_starts(UsageLevel level)
    {
        _usage.Level = level;
        var error = await Assert.ThrowsAsync<DomainException>(async () => await Join("conn-a", HostProof));
        Assert.Equal("Calls are paused.", error.Message);
        Assert.Equal(new(0, 0), _rooms.Stats());
    }

    [Fact]
    public async Task At_audio_only_nobody_new_joins_a_running_call_but_reconnects_do()
    {
        var host = (await Join("conn-a", HostProof)).Self!;
        _usage.Level = UsageLevel.AudioOnly;

        var guest = await Assert.ThrowsAsync<DomainException>(async () => await Join("conn-b", identity: TestIdentity.Distinct("bob")));
        Assert.Equal("Calls are paused.", guest.Message);

        var ticket = new TicketInput(host.Identity.Ed25519Pub, TestIdentity.Sig);
        var back = await Join("conn-c", identity: TestIdentity.Distinct("carol"), ticket: ticket);
        Assert.NotNull(back.Self);

        var hostAgain = await Join("conn-d", HostProof, TestIdentity.Distinct("hana2"));
        Assert.NotNull(hostAgain.Self);
    }

    [Fact]
    public async Task When_paused_not_even_reconnects_get_in()
    {
        var host = (await Join("conn-a", HostProof)).Self!;
        _usage.Level = UsageLevel.Paused;
        var ticket = new TicketInput(host.Identity.Ed25519Pub, TestIdentity.Sig);
        await Assert.ThrowsAsync<DomainException>(async () => await Join("conn-b", identity: TestIdentity.Distinct("bob"), ticket: ticket));
    }

    [Fact]
    public async Task At_audio_only_subscribing_drops_video_silently()
    {
        var (alice, _) = Call();
        _usage.Level = UsageLevel.AudioOnly;
        _sfu.SubscribeAsync(default!, default!, _ct).ReturnsForAnyArgs(call =>
            new SfuSubscribeResult("v=0 offer", [.. call.Arg<IReadOnlyList<SfuRemoteTrack>>().Select((t, i) => new SfuPulledTrack(t.PublisherSessionId, t.TrackName, $"{i}"))]));

        var result = await Subscribe(alice, "microphone", "camera", "screen");

        Assert.Equal([TrackSource.Microphone], result.Tracks.Select(t => t.Source));
        var onlyVideo = await Subscribe(alice, "camera");
        Assert.Same(SubscribeTracksResult.Nothing, onlyVideo);
    }

    [Fact]
    public async Task While_saving_cameras_are_held_at_the_half_layer()
    {
        var (alice, _) = Call();
        _usage.Level = UsageLevel.Saving;
        _sfu.SubscribeAsync(default!, default!, _ct).ReturnsForAnyArgs(call =>
            new SfuSubscribeResult("v=0 offer", [.. call.Arg<IReadOnlyList<SfuRemoteTrack>>().Select((t, i) => new SfuPulledTrack(t.PublisherSessionId, t.TrackName, $"m{i}"))]));

        var result = await Subscribe(alice, "microphone", "camera");
        var camera = result.Tracks.Single(t => t.Source == TrackSource.Camera);
        await _sfu.Received(1).SelectLayerAsync("sess-b", camera.Mid, Arg.Is<SfuRemoteTrack>(t => t.Simulcast), "h", _ct);

        // The subscriber asking for the full layer gets the half one.
        await new SelectVideoLayerCommandHandler(_rooms, _sfu, _usage).Handle(new SelectVideoLayerCommand("conn-b", camera.Mid, "f"), _ct);
        await _sfu.Received(2).SelectLayerAsync("sess-b", camera.Mid, Arg.Any<SfuRemoteTrack>(), "h", _ct);
        await new SelectVideoLayerCommandHandler(_rooms, _sfu, _usage).Handle(new SelectVideoLayerCommand("conn-b", camera.Mid, "q"), _ct);
        await _sfu.Received(1).SelectLayerAsync("sess-b", camera.Mid, Arg.Any<SfuRemoteTrack>(), "q", _ct);
    }

    [Fact]
    public async Task Reaching_saving_moves_every_received_camera_to_the_half_layer()
    {
        var (alice, _) = Call();
        Subscribed("conn-b", alice, ("6", TrackSource.Microphone), ("7", TrackSource.Camera));

        await Apply(UsageLevel.Saving);

        await _sfu.Received(1).SelectLayerAsync("sess-b", "7", new SfuRemoteTrack("sess-a", $"{alice.Id}-camera", true), "h", _ct);
        await _sfu.DidNotReceive().SelectLayerAsync("sess-b", "6", Arg.Any<SfuRemoteTrack>(), Arg.Any<string>(), _ct);
    }

    [Fact]
    public async Task Reaching_audio_only_stops_forwarding_video_and_keeps_audio()
    {
        var (alice, _) = Call();
        Subscribed("conn-b", alice, ("6", TrackSource.Microphone), ("7", TrackSource.Camera), ("8", TrackSource.Screen));

        await Apply(UsageLevel.AudioOnly);

        await _sfu.Received(1).CloseTracksAsync("sess-b", Arg.Is<IReadOnlyList<string>>(m => m.SequenceEqual(VideoMids)), _ct);
        Assert.Equal(["6"], _rooms.FindByConnection("conn-b")!.Subscriptions.Select(s => s.Mid));
    }

    [Fact]
    public async Task Reaching_audio_only_sends_the_lobby_away_and_admitting_is_refused()
    {
        var (alice, _) = Call();
        var guest = _rooms.Enter(alice.RoomId, "conn-guest", room => room.EnterLobby("conn-guest", TestIdentity.Distinct("guest"), VideoCodecs.Baseline, DateTimeOffset.UnixEpoch));

        var result = await Apply(UsageLevel.AudioOnly);
        Assert.Equal(["conn-guest"], result.Ended.Select(e => e.ConnectionId));
        Assert.Equal(2, _rooms.Stats().Participants);

        _usage.Level = UsageLevel.AudioOnly;
        var error = await Assert.ThrowsAsync<DomainException>(async () =>
            await new Cipheroom.Application.Admission.Commands.Admit.AdmitCommandHandler(_rooms, new FakeSignatureVerifier(), TestMetrics.Create(_rooms).Metrics, _usage)
                .Handle(new Cipheroom.Application.Admission.Commands.Admit.AdmitCommand("conn-a", guest.Id.Value, TestIdentity.Sig), _ct));
        Assert.Equal("Calls are paused.", error.Message);
    }

    [Fact]
    public async Task Pausing_ends_every_call_and_lobby()
    {
        var (alice, _) = Call();
        Subscribed("conn-b", alice, ("6", TrackSource.Microphone));
        _rooms.Enter(alice.RoomId, "conn-guest", room => room.EnterLobby("conn-guest", TestIdentity.Distinct("guest"), VideoCodecs.Baseline, DateTimeOffset.UnixEpoch));

        var result = await Apply(UsageLevel.Paused);

        await _sfu.Received(1).CloseTracksAsync("sess-b", Arg.Is<IReadOnlyList<string>>(m => m.SequenceEqual(AudioMids)), _ct);
        Assert.Equal(["conn-a", "conn-b", "conn-guest"], result.Ended.Select(e => e.ConnectionId).Order());
        Assert.Equal(new(0, 0), _rooms.Stats());
    }

    private (Participant Alice, Participant Bob) Call()
    {
        var alice = _rooms.Join("conn-a", sfuSessionId: "sess-a");
        _rooms.InRoom("conn-a", (room, self) => room.Publish(self.Id, [(TrackSource.Microphone, "0"), (TrackSource.Camera, "1"), (TrackSource.Screen, "2")]));
        var bob = _rooms.Join("conn-b", sfuSessionId: "sess-b");
        return (alice, bob);
    }

    private void Subscribed(string connectionId, Participant publisher, params (string Mid, TrackSource Source)[] tracks) =>
        _rooms.InRoom(connectionId, (room, self) =>
        {
            room.Subscribe(self.Id, [.. tracks.Select(t => new Subscription(t.Mid, publisher.Id, t.Source))]);
            return self;
        });

    private Task<SubscribeTracksResult> Subscribe(Participant publisher, params string[] sources) =>
        new SubscribeTracksCommandHandler(_rooms, _sfu, _usage)
            .Handle(new SubscribeTracksCommand("conn-b", [.. sources.Select(s => new SubscribeTrackInput(publisher.Id.Value, s))]), _ct)
            .AsTask();

    private Task<ApplyUsageLevelResult> Apply(UsageLevel level) =>
        new ApplyUsageLevelCommandHandler(_rooms, _sfu).Handle(new ApplyUsageLevelCommand(level), _ct).AsTask();

    private Task<JoinLobbyResult> Join(string connectionId, HostProofInput? hostProof = null, IdentityKeys? identity = null, TicketInput? ticket = null)
    {
        var keys = identity ?? TestIdentity.Keys;
        var command = new JoinLobbyCommand(connectionId, TestIdentity.HostedRoom, new IdentityInput(keys.Ed25519Pub, keys.X25519Pub, keys.Sig), TestIdentity.Codecs, hostProof, ticket);
        return new JoinLobbyCommandHandler(_rooms, new FakeSignatureVerifier(), new FakeTimeProvider(), TestMetrics.Create(_rooms).Metrics, _usage).Handle(command, _ct).AsTask();
    }
}
