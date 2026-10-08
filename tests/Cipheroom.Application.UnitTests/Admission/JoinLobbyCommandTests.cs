using Cipheroom.Application.Admission;
using Cipheroom.Application.Admission.Commands.JoinLobby;
using Cipheroom.Application.UnitTests.Common;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;
using Microsoft.Extensions.Time.Testing;

namespace Cipheroom.Application.UnitTests.Admission;

public sealed class JoinLobbyCommandTests
{
    private static readonly HostProofInput HostProof = new(TestIdentity.Ed25519Pub, TestIdentity.X25519Pub, TestIdentity.Sig);

    private readonly JoinLobbyCommandValidator _validator = new();
    private readonly FakeRoomStore _rooms = new();
    private readonly FakeSignatureVerifier _verifier = new();
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    [Fact]
    public void Valid_input_passes() =>
        Assert.True(_validator.Validate(Command("conn", hostProof: HostProof)).IsValid);

    [Theory]
    [InlineData(null)]
    [InlineData("room-1")] // the old random format
    [InlineData("UPPERCASEUPPERCASEUPPERCAS")]
    public void Bad_room_id_gives_the_room_message(string? roomId) =>
        Assert.Equal(["Invalid room id."], Messages(Command("conn") with { RoomId = roomId }));

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
        Assert.Equal(["Invalid identity."], Messages(Command("conn") with { Identity = identity }));

    [Theory]
    [InlineData(null)] // what a client sends when it leaves the argument out
    [InlineData("")]
    [InlineData("vp9")] // vp8 is the baseline everyone decodes
    [InlineData("vp8,vp8")]
    [InlineData("vp8,h264")]
    [InlineData("vp8,av1")] // AV1 was removed
    public void Missing_or_malformed_codecs_give_the_codecs_message(string? codecs) =>
        Assert.Equal(
            ["Invalid video codecs."],
            Messages(Command("conn") with { VideoCodecs = codecs?.Split(',', StringSplitOptions.RemoveEmptyEntries) }));

    [Fact]
    public void Malformed_host_proof_or_ticket_is_rejected()
    {
        Assert.Equal(["Invalid host proof."], Messages(Command("conn", hostProof: HostProof with { Attestation = "short" })));
        Assert.Equal(["Invalid signature."], Messages(Command("conn") with { Ticket = new TicketInput(TestIdentity.Ed25519Pub, null) }));
    }

    [Fact]
    public void Messages_never_echo_the_input()
    {
        const string hostile = "<script>alert(1)</script>";
        Assert.All(Messages(Command("conn") with { RoomId = hostile }), m => Assert.DoesNotContain(hostile, m, StringComparison.Ordinal));
    }

    [Fact]
    public async Task The_host_joins_straight_in()
    {
        var result = await Handle(Command("conn-a", hostProof: HostProof));

        Assert.Equal(ParticipantRole.Host, result.Self!.Role);
        Assert.True(result.AuthorityChanged);
        Assert.Equal(TestIdentity.Host, result.Authority.Host);
        Assert.Equal(AdmissionMessages.Host(new RoomId(TestIdentity.HostedRoom), TestIdentity.Ed25519Pub), Assert.Single(_verifier.Checked).Message);
    }

    [Fact]
    public async Task A_host_proof_for_another_room_or_with_a_bad_signature_is_refused()
    {
        var wrongRoom = Command("conn-a", hostProof: HostProof) with { RoomId = new string('b', 26) };
        Assert.Equal("Invalid host proof.", (await Assert.ThrowsAsync<DomainException>(async () => await Handle(wrongRoom))).Message);

        _verifier.Valid = false;
        Assert.Equal("Invalid host proof.", (await Assert.ThrowsAsync<DomainException>(async () => await Handle(Command("conn-a", hostProof: HostProof)))).Message);
        Assert.Equal(new(0, 0), _rooms.Stats());
    }

    [Fact]
    public async Task Everyone_else_waits_in_the_lobby_and_sees_nobody()
    {
        await Handle(Command("conn-a", hostProof: HostProof));

        var result = await Handle(Command("conn-b"));

        Assert.Null(result.Self);
        Assert.NotNull(result.Guest);
        Assert.Empty(result.Others);
        Assert.False(result.AuthorityChanged);
    }

    [Fact]
    public async Task A_valid_ticket_from_earlier_in_the_call_skips_the_lobby()
    {
        var host = (await Handle(Command("conn-a", hostProof: HostProof))).Self!;
        var ticket = new TicketInput(host.Identity.Ed25519Pub, TestIdentity.Sig);

        var back = await Handle(Command("conn-b", identity: TestIdentity.Distinct("bob")) with { Ticket = ticket });
        Assert.NotNull(back.Self);
        Assert.Equal(ParticipantRole.Guest, back.Self.Role);

        _verifier.Valid = false;
        var forged = await Handle(Command("conn-c", identity: TestIdentity.Distinct("carol")) with { Ticket = ticket });
        Assert.Null(forged.Self);
    }

    [Fact]
    public async Task A_connection_can_only_be_in_one_room()
    {
        await Handle(Command("conn-a", hostProof: HostProof));
        var error = await Assert.ThrowsAsync<DomainException>(async () => await Handle(Command("conn-a")));
        Assert.Equal("Already in a room.", error.Message);
    }

    private static JoinLobbyCommand Command(string connectionId, HostProofInput? hostProof = null, IdentityKeys? identity = null)
    {
        var keys = identity ?? TestIdentity.Keys;
        return new(connectionId, TestIdentity.HostedRoom, new IdentityInput(keys.Ed25519Pub, keys.X25519Pub, keys.Sig), TestIdentity.Codecs, hostProof);
    }

    private async Task<JoinLobbyResult> Handle(JoinLobbyCommand command) =>
        await new JoinLobbyCommandHandler(_rooms, _verifier, new FakeTimeProvider(), TestMetrics.Create(_rooms).Metrics).Handle(command, _ct);

    private string[] Messages(JoinLobbyCommand command) => [.. _validator.Validate(command).Errors.Select(e => e.ErrorMessage)];
}
