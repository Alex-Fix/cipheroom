using Cipheroom.Application.Chat;
using Cipheroom.Application.Chat.Commands.SendChat;
using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.UnitTests.Common;

namespace Cipheroom.Application.UnitTests.Chat;

public sealed class SendChatCommandTests
{
    private const string Blob = "Y2hhdA";

    private readonly FakeRoomStore _rooms = new();
    private readonly SendChatCommandValidator _validator = new();
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    [Fact]
    public async Task The_sender_and_room_are_set_by_the_server()
    {
        var alice = _rooms.Join("conn-a");
        _rooms.Join("conn-x", roomId: "room-2");

        var result = await Handle(new("conn-a", Blob));

        Assert.Equal(alice.Id, result.FromId);
        Assert.Equal(_rooms.RoomOf("conn-a").Id, result.RoomId);
    }

    [Fact]
    public async Task Sending_before_joining_is_rejected()
    {
        var error = await Assert.ThrowsAsync<NotFoundException>(async () => await Handle(new("conn-a", Blob)));
        Assert.Equal("Join a room first.", error.Message);
    }

    [Fact]
    public void A_well_formed_blob_passes_validation() =>
        Assert.True(_validator.Validate(new SendChatCommand("conn", Blob)).IsValid);

    [Fact]
    public void A_blob_of_the_maximum_length_is_accepted() =>
        Assert.True(_validator.Validate(new SendChatCommand("conn", new string('A', ChatRules.MaxBlobLength))).IsValid);

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("has spaces")]
    [InlineData("padded==")]
    [InlineData("plus+slash/")]
    public void Malformed_blobs_are_rejected_with_one_constant_message(string? blob)
    {
        var result = _validator.Validate(new SendChatCommand("conn", blob));
        Assert.Equal(["Invalid chat message."], result.Errors.Select(e => e.ErrorMessage));
    }

    [Fact]
    public void An_oversized_blob_is_rejected()
    {
        var result = _validator.Validate(new SendChatCommand("conn", new string('A', ChatRules.MaxBlobLength + 1)));
        Assert.Equal(["Invalid chat message."], result.Errors.Select(e => e.ErrorMessage));
    }

    private ValueTask<SendChatResult> Handle(SendChatCommand command) =>
        new SendChatCommandHandler(_rooms, TestMetrics.Create(_rooms).Metrics).Handle(command, _ct);
}
