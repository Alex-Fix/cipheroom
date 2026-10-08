using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Rooms.Commands.JoinRoom;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;
using NSubstitute;

namespace Cipheroom.Application.UnitTests.Rooms;

public sealed class JoinRoomCommandTests
{
    private readonly JoinRoomCommandValidator _validator = new();

    [Fact]
    public void Valid_input_passes() =>
        Assert.True(_validator.Validate(new JoinRoomCommand("conn", "room-1", " Alice ", TestIdentity.Input, TestIdentity.Codecs)).IsValid);

    [Theory]
    [InlineData(null)]
    [InlineData("ab")]
    [InlineData("UPPER")]
    public void Bad_room_id_gives_the_room_message(string? roomId) =>
        Assert.Equal(["Invalid room id."], Messages(new JoinRoomCommand("conn", roomId, "Alice", TestIdentity.Input, TestIdentity.Codecs)));

    [Theory]
    [InlineData(null)]
    [InlineData("   ")]
    public void Bad_name_gives_the_name_message(string? name) =>
        Assert.Equal(["Display name must be 1-64 characters."], Messages(new JoinRoomCommand("conn", "room-1", name, TestIdentity.Input, TestIdentity.Codecs)));

    public static TheoryData<IdentityInput?> BadIdentities => new()
    {
        null!, // what a client sends when it leaves the argument out
        new IdentityInput(null, TestIdentity.X25519Pub, TestIdentity.Sig),
        new IdentityInput(TestIdentity.Ed25519Pub, "short", TestIdentity.Sig),
        new IdentityInput(TestIdentity.Ed25519Pub, TestIdentity.X25519Pub, TestIdentity.Ed25519Pub),
    };

    [Theory]
    [MemberData(nameof(BadIdentities))]
    public void Missing_or_malformed_identity_gives_the_identity_message(IdentityInput? identity) =>
        Assert.Equal(["Invalid identity."], Messages(new JoinRoomCommand("conn", "room-1", "Alice", identity, TestIdentity.Codecs)));

    [Theory]
    [InlineData(null)] // what a client sends when it leaves the argument out
    [InlineData("")]
    [InlineData("vp9")] // vp8 is the baseline everyone decodes
    [InlineData("vp8,vp8")]
    [InlineData("vp8,h264")]
    [InlineData("vp8,VP9")]
    [InlineData("vp8,av1")] // AV1 was removed
    [InlineData("vp8,vp9,vp8")]
    public void Missing_or_malformed_codecs_give_the_codecs_message(string? codecs) =>
        Assert.Equal(
            ["Invalid video codecs."],
            Messages(new JoinRoomCommand("conn", "room-1", "Alice", TestIdentity.Input, codecs is null ? null : codecs.Split(',', StringSplitOptions.RemoveEmptyEntries))));

    [Fact]
    public void A_null_codec_gives_the_codecs_message() =>
        Assert.Equal(["Invalid video codecs."], Messages(new JoinRoomCommand("conn", "room-1", "Alice", TestIdentity.Input, ["vp8", null])));

    [Fact]
    public void Only_the_first_problem_is_reported() =>
        Assert.Equal(["Invalid room id."], Messages(new JoinRoomCommand("conn", "X", "", TestIdentity.Input, TestIdentity.Codecs)));

    [Fact]
    public void Messages_never_echo_the_input()
    {
        const string hostile = "<script>alert(1)</script>";
        Assert.All(Messages(new JoinRoomCommand("conn", hostile, hostile, TestIdentity.Input, TestIdentity.Codecs)), m => Assert.DoesNotContain(hostile, m, StringComparison.Ordinal));
    }

    [Fact]
    public async Task Handler_joins_with_trimmed_name_and_returns_others()
    {
        var store = Substitute.For<IRoomStore>();
        var bob = new Participant(ParticipantId.New(), new RoomId("room-1"), "conn-b", new DisplayName("Bob"), TestIdentity.Keys);
        store.TryJoin(new RoomId("room-1"), "conn-a", new DisplayName("Alice"), Arg.Any<IdentityKeys>(), Arg.Any<VideoCodecs>(), out Arg.Any<Participant?>(), out Arg.Any<IReadOnlyList<Participant>?>())
            .Returns(call =>
            {
                call[5] = new Participant(ParticipantId.New(), (RoomId)call[0], (string)call[1], (DisplayName)call[2], (IdentityKeys)call[3])
                {
                    VideoCodecs = (VideoCodecs)call[4],
                };
                call[6] = new List<Participant> { bob };
                return true;
            });

        var result = await new JoinRoomCommandHandler(store).Handle(new JoinRoomCommand("conn-a", "room-1", " Alice ", TestIdentity.Input, TestIdentity.Codecs), TestContext.Current.CancellationToken);

        Assert.Equal("Alice", result.Self.DisplayName.Value);
        Assert.Equal(["vp8", "vp9"], result.Self.VideoCodecs.Values);
        Assert.Equal([bob], result.Others);
    }

    [Fact]
    public async Task Handler_rejects_a_connection_that_is_already_in_a_room()
    {
        var store = Substitute.For<IRoomStore>();
        store.TryJoin(default!, default!, default!, default!, default!, out _, out _).ReturnsForAnyArgs(false);

        var error = await Assert.ThrowsAsync<DomainException>(async () =>
            await new JoinRoomCommandHandler(store).Handle(new JoinRoomCommand("conn-a", "room-1", "Alice", TestIdentity.Input, TestIdentity.Codecs), TestContext.Current.CancellationToken));
        Assert.Equal("Already in a room.", error.Message);
    }

    private string[] Messages(JoinRoomCommand command) =>
        _validator.Validate(command).Errors.Select(e => e.ErrorMessage).ToArray();
}
