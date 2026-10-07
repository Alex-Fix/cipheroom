using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Keys;
using Cipheroom.Application.Keys.Commands.SendKeyEnvelopes;
using Cipheroom.Application.UnitTests.Common;
using Cipheroom.Domain.Common;

namespace Cipheroom.Application.UnitTests.Keys;

public sealed class SendKeyEnvelopesCommandTests
{
    private const string Blob = "ZW52ZWxvcGU";

    private readonly FakeRoomStore _rooms = new();
    private readonly SendKeyEnvelopesCommandValidator _validator = new();
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    [Fact]
    public async Task Each_envelope_goes_to_its_recipients_connection_with_the_sender_set_by_the_server()
    {
        var alice = _rooms.Join("conn-a");
        var bob = _rooms.Join("conn-b");
        var carol = _rooms.Join("conn-c");

        var result = await Handle(new("conn-a", [new(bob.Id.Value, "for-bob"), new(carol.Id.Value, "for-carol")]));

        Assert.Equal(alice.Id, result.FromId);
        Assert.Equal([new KeyEnvelopeDelivery("conn-b", "for-bob"), new KeyEnvelopeDelivery("conn-c", "for-carol")], result.Deliveries);
    }

    [Fact]
    public async Task Envelopes_to_someone_in_another_room_are_rejected()
    {
        _rooms.Join("conn-a");
        var stranger = _rooms.Join("conn-x", roomId: "room-2");

        var error = await Assert.ThrowsAsync<DomainException>(async () => await Handle(new("conn-a", [new(stranger.Id.Value, Blob)])));
        Assert.Equal("Invalid key envelope.", error.Message);
    }

    [Fact]
    public async Task Sending_before_joining_is_rejected()
    {
        var error = await Assert.ThrowsAsync<NotFoundException>(async () => await Handle(new("conn-a", [new("0123456789abcdef", Blob)])));
        Assert.Equal("Join a room first.", error.Message);
    }

    [Fact]
    public void Well_formed_envelopes_pass_validation() =>
        Assert.True(_validator.Validate(new SendKeyEnvelopesCommand("conn", [new("0123456789abcdef", Blob)])).IsValid);

    public static TheoryData<KeyEnvelopeInput?[]?> Malformed => new()
    {
        null!, // what a client sends when it leaves the argument out
        Array.Empty<KeyEnvelopeInput?>(),
        new KeyEnvelopeInput?[] { null },
        new KeyEnvelopeInput?[] { new("not-an-id", Blob) },
        new KeyEnvelopeInput?[] { new("0123456789abcdef", null) },
        new KeyEnvelopeInput?[] { new("0123456789abcdef", "") },
        new KeyEnvelopeInput?[] { new("0123456789abcdef", "has spaces") },
        new KeyEnvelopeInput?[] { new("0123456789abcdef", "padded==") },
        new KeyEnvelopeInput?[] { new("0123456789abcdef", new string('A', KeyRules.MaxBlobLength + 1)) },
        new KeyEnvelopeInput?[] { new("0123456789abcdef", Blob), new("0123456789abcdef", Blob) },
        Enumerable.Range(0, KeyRules.MaxEnvelopesPerRequest + 1).Select(i => (KeyEnvelopeInput?)new($"{i:x16}", Blob)).ToArray(),
    };

    [Theory]
    [MemberData(nameof(Malformed))]
    public void Malformed_envelopes_are_rejected_with_one_constant_message(KeyEnvelopeInput?[]? envelopes)
    {
        var result = _validator.Validate(new SendKeyEnvelopesCommand("conn", envelopes));
        Assert.Equal(["Invalid key envelope."], result.Errors.Select(e => e.ErrorMessage));
    }

    [Fact]
    public void A_blob_of_the_maximum_length_is_accepted() =>
        Assert.True(_validator.Validate(new SendKeyEnvelopesCommand("conn", [new("0123456789abcdef", new string('A', KeyRules.MaxBlobLength))])).IsValid);

    private ValueTask<SendKeyEnvelopesResult> Handle(SendKeyEnvelopesCommand command) =>
        new SendKeyEnvelopesCommandHandler(_rooms).Handle(command, _ct);
}
