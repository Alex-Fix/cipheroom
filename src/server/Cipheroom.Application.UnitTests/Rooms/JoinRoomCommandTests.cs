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
        Assert.True(_validator.Validate(new JoinRoomCommand("conn", "room-1", " Alice ")).IsValid);

    [Theory]
    [InlineData(null)]
    [InlineData("ab")]
    [InlineData("UPPER")]
    public void Bad_room_id_gives_the_room_message(string? roomId) =>
        Assert.Equal(["Invalid room id."], Messages(new JoinRoomCommand("conn", roomId, "Alice")));

    [Theory]
    [InlineData(null)]
    [InlineData("   ")]
    public void Bad_name_gives_the_name_message(string? name) =>
        Assert.Equal(["Display name must be 1-64 characters."], Messages(new JoinRoomCommand("conn", "room-1", name)));

    [Fact]
    public void Only_the_first_problem_is_reported() =>
        Assert.Equal(["Invalid room id."], Messages(new JoinRoomCommand("conn", "X", "")));

    [Fact]
    public void Messages_never_echo_the_input()
    {
        const string hostile = "<script>alert(1)</script>";
        Assert.All(Messages(new JoinRoomCommand("conn", hostile, hostile)), m => Assert.DoesNotContain(hostile, m, StringComparison.Ordinal));
    }

    [Fact]
    public async Task Handler_joins_with_trimmed_name_and_returns_others()
    {
        var store = Substitute.For<IRoomStore>();
        var bob = new Participant(ParticipantId.New(), new RoomId("room-1"), "conn-b", new DisplayName("Bob"));
        store.TryJoin(new RoomId("room-1"), "conn-a", new DisplayName("Alice"), out Arg.Any<Participant?>(), out Arg.Any<IReadOnlyList<Participant>?>())
            .Returns(call =>
            {
                call[3] = new Participant(ParticipantId.New(), (RoomId)call[0], (string)call[1], (DisplayName)call[2]);
                call[4] = new List<Participant> { bob };
                return true;
            });

        var result = await new JoinRoomCommandHandler(store).Handle(new JoinRoomCommand("conn-a", "room-1", " Alice "), TestContext.Current.CancellationToken);

        Assert.Equal("Alice", result.Self.DisplayName.Value);
        Assert.Equal([bob], result.Others);
    }

    [Fact]
    public async Task Handler_rejects_a_connection_that_is_already_in_a_room()
    {
        var store = Substitute.For<IRoomStore>();
        store.TryJoin(default!, default!, default!, out _, out _).ReturnsForAnyArgs(false);

        var error = await Assert.ThrowsAsync<DomainException>(async () =>
            await new JoinRoomCommandHandler(store).Handle(new JoinRoomCommand("conn-a", "room-1", "Alice"), TestContext.Current.CancellationToken));
        Assert.Equal("Already in a room.", error.Message);
    }

    private string[] Messages(JoinRoomCommand command) =>
        _validator.Validate(command).Errors.Select(e => e.ErrorMessage).ToArray();
}
