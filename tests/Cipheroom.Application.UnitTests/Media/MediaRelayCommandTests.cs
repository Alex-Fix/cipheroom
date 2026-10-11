using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Media;
using Cipheroom.Application.Media.Commands.AnnounceTracks;
using Cipheroom.Application.Media.Commands.CloseMediaRelay;
using Cipheroom.Application.Media.Commands.OpenMediaRelay;
using Cipheroom.Application.Media.Commands.SendMediaRelay;
using Cipheroom.Application.UnitTests.Common;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;
using NSubstitute;

namespace Cipheroom.Application.UnitTests.Media;

/// <summary>LiveKit mode: the signaling relay and announced tracks (docs/plans/2026-10-11-livekit-media-mode-design.md).</summary>
public sealed class MediaRelayCommandTests
{
    private const string RelayId = "0123456789abcdef";

    private readonly FakeRoomStore _rooms = new();
    private readonly IMediaRoom _media = Substitute.For<IMediaRoom>();
    private readonly IMediaRelay _relay = Substitute.For<IMediaRelay>();
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    public MediaRelayCommandTests() => _media.Provider.Returns(MediaProvider.LiveKit);

    [Fact]
    public async Task Opens_a_relay_for_a_member_with_their_room_and_identity()
    {
        var alice = _rooms.Join("conn-a");

        await Open(new("conn-a", RelayId, "/rtc/v1", "join_request=abc"));

        await _relay.Received(1).OpenAsync(new MediaRelayOwner("conn-a", alice.RoomId, alice.Id), RelayId, "/rtc/v1", "join_request=abc", _ct);
    }

    [Fact]
    public async Task Only_members_get_a_relay()
    {
        var error = await Assert.ThrowsAsync<NotFoundException>(async () => await Open(new("nobody", RelayId, "/rtc/v1", "")));
        Assert.Equal(MediaRules.NotInRoom, error.Message);
        await _relay.DidNotReceiveWithAnyArgs().OpenAsync(default!, default!, default!, default!, _ct);
    }

    [Fact]
    public async Task Relays_and_announcements_are_refused_on_cloudflare()
    {
        _rooms.Join("conn-a");
        _media.Provider.Returns(MediaProvider.Cloudflare);

        var open = await Assert.ThrowsAsync<DomainException>(async () => await Open(new("conn-a", RelayId, "/rtc/v1", "")));
        var announce = await Assert.ThrowsAsync<DomainException>(async () => await Announce("conn-a", "camera"));

        Assert.Equal(MediaRules.NotInThisMode, open.Message);
        Assert.Equal(MediaRules.NotInThisMode, announce.Message);
    }

    [Theory]
    [InlineData("0123456789ABCDEF", "/rtc/v1", "")] // uppercase id
    [InlineData("0123456789abcde", "/rtc/v1", "")] // short id
    [InlineData(RelayId, "/twirp/livekit.RoomService/DeleteRoom", "")] // not a signaling path
    [InlineData(RelayId, null, "")]
    public void Open_validator_rejects_bad_ids_and_paths(string? id, string? path, string query)
    {
        var errors = new OpenMediaRelayCommandValidator().Validate(new OpenMediaRelayCommand("c", id, path, query)).Errors;
        Assert.Equal([MediaRules.InvalidRelay], errors.Select(e => e.ErrorMessage));
    }

    [Fact]
    public void Open_validator_rejects_an_oversized_query() =>
        Assert.False(new OpenMediaRelayCommandValidator().Validate(new OpenMediaRelayCommand("c", RelayId, "/rtc/v1", new string('a', MediaRules.MaxRelayQueryLength + 1))).IsValid);

    [Fact]
    public async Task Sends_the_decoded_message_upstream()
    {
        await new SendMediaRelayCommandHandler(_relay).Handle(new("conn-a", RelayId, Convert.ToBase64String([1, 2, 3]), Text: false), _ct);

        await _relay.Received(1).SendAsync("conn-a", RelayId, Arg.Is<ReadOnlyMemory<byte>>(m => m.ToArray().SequenceEqual(new byte[] { 1, 2, 3 })), false, _ct);
    }

    [Theory]
    [InlineData("not base64!")]
    [InlineData("")]
    public void Send_validator_rejects_what_is_not_base64(string message) =>
        Assert.False(new SendMediaRelayCommandValidator().Validate(new SendMediaRelayCommand("c", RelayId, message, false)).IsValid);

    [Fact]
    public void Send_validator_rejects_messages_over_the_limit()
    {
        var validator = new SendMediaRelayCommandValidator();
        Assert.True(validator.Validate(new SendMediaRelayCommand("c", RelayId, Convert.ToBase64String(new byte[MediaRules.MaxRelayMessageBytes]), false)).IsValid);
        Assert.False(validator.Validate(new SendMediaRelayCommand("c", RelayId, Convert.ToBase64String(new byte[MediaRules.MaxRelayMessageBytes + 3]), false)).IsValid);
    }

    [Fact]
    public async Task Closing_forwards_to_the_relay()
    {
        await new CloseMediaRelayCommandHandler(_relay).Handle(new("conn-a", RelayId), _ct);
        await _relay.Received(1).CloseAsync("conn-a", RelayId);
    }

    [Fact]
    public async Task Announced_sources_become_the_members_published_tracks()
    {
        _rooms.Join("conn-a");

        var result = await Announce("conn-a", "microphone", "camera");

        Assert.Equal([TrackSource.Microphone, TrackSource.Camera], result.Self.Tracks.Select(t => t.Source));
        Assert.Equal([TrackSource.Microphone, TrackSource.Camera], result.Tracks.Select(t => t.Source));
        Assert.Null(result.Self.SfuSessionId); // no Cloudflare session in LiveKit mode
    }

    [Fact]
    public async Task A_source_is_announced_once()
    {
        _rooms.Join("conn-a");
        await Announce("conn-a", "camera");

        await Assert.ThrowsAsync<DomainException>(async () => await Announce("conn-a", "camera"));
    }

    [Fact]
    public void Announce_validator_rejects_unknown_and_repeated_sources()
    {
        var validator = new AnnounceTracksCommandValidator();
        Assert.False(validator.Validate(new AnnounceTracksCommand("c", ["webcam"])).IsValid);
        Assert.False(validator.Validate(new AnnounceTracksCommand("c", ["camera", "camera"])).IsValid);
        Assert.False(validator.Validate(new AnnounceTracksCommand("c", [])).IsValid);
    }

    private ValueTask<Mediator.Unit> Open(OpenMediaRelayCommand command) =>
        new OpenMediaRelayCommandHandler(_rooms, _media, _relay).Handle(command, _ct);

    private ValueTask<AnnounceTracksResult> Announce(string connectionId, params string[] sources) =>
        new AnnounceTracksCommandHandler(_rooms, _media).Handle(new(connectionId, sources), _ct);
}
