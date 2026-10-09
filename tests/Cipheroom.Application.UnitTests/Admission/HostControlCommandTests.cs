using Cipheroom.Application.Admission;
using Cipheroom.Application.Admission.Commands.Admit;
using Cipheroom.Application.Admission.Commands.AskToMute;
using Cipheroom.Application.Admission.Commands.Deny;
using Cipheroom.Application.Admission.Commands.EndCall;
using Cipheroom.Application.Admission.Commands.GrantCoHost;
using Cipheroom.Application.Admission.Commands.Knock;
using Cipheroom.Application.Admission.Commands.RemoveParticipant;
using Cipheroom.Application.Admission.Commands.UpdateSettings;
using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Rooms.Commands.LeaveRoom;
using Cipheroom.Application.UnitTests.Common;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;

namespace Cipheroom.Application.UnitTests.Admission;

public sealed class HostControlCommandTests
{
    private const string Sig = TestIdentity.Sig;

    private readonly FakeRoomStore _rooms = new();
    private readonly FakeSignatureVerifier _verifier = new();
    private readonly FakeUsageGuard _usage = new();
    private readonly ISfu _sfu = Substitute.For<ISfu>();
    private readonly FakeTimeProvider _time = new();
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;
    private readonly Participant _host;
    private readonly RoomId _room;

    public HostControlCommandTests()
    {
        _host = _rooms.Join("host");
        _room = _host.RoomId;
    }

    [Fact]
    public async Task Admit_checks_the_ticket_and_moves_the_guest_in()
    {
        var guest = Waiting("guest");

        var result = await new AdmitCommandHandler(_rooms, _verifier, Metrics(), _usage).Handle(new("host", guest.Id.Value, Sig), _ct);

        Assert.Equal(guest.Id, result.Admitted.Id);
        Assert.Equal([_host], result.Others);
        var (key, message) = Assert.Single(_verifier.Checked);
        Assert.Equal(AdmissionMessages.Ticket(_room, _host.Identity.Ed25519Pub, guest.Identity.Ed25519Pub), message);
        Assert.Equal(System.Buffers.Text.Base64Url.DecodeFromChars(_host.Identity.Ed25519Pub), key);
    }

    [Fact]
    public async Task A_ticket_that_does_not_verify_admits_nobody()
    {
        var guest = Waiting("guest");
        _verifier.Valid = false;

        var error = await Assert.ThrowsAsync<DomainException>(async () =>
            await new AdmitCommandHandler(_rooms, _verifier, Metrics(), _usage).Handle(new("host", guest.Id.Value, Sig), _ct));

        Assert.Equal("Invalid signature.", error.Message);
        Assert.Equal([guest], _rooms.RoomOf("host").Lobby);
    }

    [Fact]
    public async Task Lobby_guests_cannot_admit_or_use_member_methods()
    {
        var guest = Waiting("guest");
        var other = Waiting("other");

        var error = await Assert.ThrowsAsync<DomainException>(async () =>
            await new AdmitCommandHandler(_rooms, _verifier, Metrics(), _usage).Handle(new("guest", other.Id.Value, Sig), _ct));
        Assert.Equal("Not admitted.", error.Message);
        Assert.NotNull(guest);
    }

    [Fact]
    public async Task Knocks_go_to_admitters_connections_only()
    {
        var bob = _rooms.Join("bob");
        var guest = Waiting("guest");
        var handler = new KnockCommandHandler(_rooms);

        var result = await handler.Handle(new("guest", [new(_host.Id.Value, "for-host")]), _ct);
        Assert.Equal(guest.Id, result.Guest.Id);
        Assert.Equal([new KnockDelivery("host", "for-host")], result.Deliveries);

        var error = await Assert.ThrowsAsync<DomainException>(async () => await handler.Handle(new("guest", [new(bob.Id.Value, "x")]), _ct));
        Assert.Equal("Invalid knock.", error.Message);
        var member = await Assert.ThrowsAsync<DomainException>(async () => await handler.Handle(new("bob", [new(_host.Id.Value, "x")]), _ct));
        Assert.Equal("Not allowed.", member.Message);
    }

    [Fact]
    public void Knock_validation_rejects_bad_lists_with_one_message()
    {
        var validator = new KnockCommandValidator();
        var id = ParticipantId.New().Value;
        Assert.All(
            new IReadOnlyList<KnockInput?>?[] { null, [], [new(id, "a"), new(id, "b")], [new("x", "a")], [new(id, new string('a', 2049))] },
            knocks => Assert.Equal(["Invalid knock."], validator.Validate(new KnockCommand("c", knocks)).Errors.Select(e => e.ErrorMessage)));
    }

    [Fact]
    public async Task Deny_turns_the_guest_away_and_names_who_to_tell()
    {
        var guest = Waiting("guest");

        var result = await new DenyCommandHandler(_rooms, _time, Metrics()).Handle(new("host", guest.Id.Value), _ct);

        Assert.Equal(guest.Id, result.Guest.Id);
        Assert.Equal([_host], result.Admitters);
        Assert.Null(_rooms.InAnyRoom("guest", r => r));
    }

    [Fact]
    public async Task Grant_and_remove_check_their_statements()
    {
        var bob = _rooms.Join("bob");
        var carol = _rooms.Join("carol", sfuSessionId: "sess-c");

        var granted = await new GrantCoHostCommandHandler(_rooms, _verifier).Handle(new("host", bob.Id.Value, Sig), _ct);
        Assert.Contains(granted.Authority.Admitters, a => a.Id == bob.Id);

        var removed = await new RemoveParticipantCommandHandler(_rooms, _verifier, _sfu, Metrics()).Handle(new("bob", carol.Id.Value, Sig), _ct);
        Assert.Equal(carol.Id, removed.Removed.Id);
        Assert.Single(removed.Authority.Revoked);

        Assert.Equal(
            [
                AdmissionMessages.CoHost(_room, _host.Identity.Ed25519Pub, bob.Identity.Ed25519Pub),
                AdmissionMessages.Revoke(_room, bob.Identity.Ed25519Pub, carol.Identity.Ed25519Pub),
            ],
            _verifier.Checked.Select(c => c.Message));
    }

    [Fact]
    public async Task Removing_someone_stops_their_media_session_receiving()
    {
        var bob = _rooms.Join("bob", sfuSessionId: "sess-b");
        _rooms.InRoom("bob", (room, self) => room.Publish(self.Id, [(TrackSource.Camera, "7")]));

        await new RemoveParticipantCommandHandler(_rooms, _verifier, _sfu, Metrics()).Handle(new("host", bob.Id.Value, Sig), _ct);

        await _sfu.Received(1).CloseTracksAsync("sess-b", Arg.Is<IReadOnlyList<string>>(m => m.Count == 1 && m[0] == "7"), _ct);
    }

    [Fact]
    public async Task A_failing_media_server_does_not_undo_a_removal()
    {
        var bob = _rooms.Join("bob", sfuSessionId: "sess-b");
        _rooms.InRoom("bob", (room, self) => room.Publish(self.Id, [(TrackSource.Camera, "7")]));
        _sfu.CloseTracksAsync(default!, default!, _ct).ReturnsForAnyArgs(Task.FromException(new MediaServerException()));

        var result = await new RemoveParticipantCommandHandler(_rooms, _verifier, _sfu, Metrics()).Handle(new("host", bob.Id.Value, Sig), _ct);
        Assert.Equal(bob.Id, result.Removed.Id);
    }

    [Fact]
    public async Task Settings_are_signed_and_only_go_forward()
    {
        var handler = new UpdateSettingsCommandHandler(_rooms, _verifier);
        var result = await handler.Handle(new("host", 1, true, Sig), _ct);

        Assert.True(result.Authority.Settings!.AutoAdmit);
        Assert.Equal(AdmissionMessages.Settings(_room, _host.Identity.Ed25519Pub, 1, true), Assert.Single(_verifier.Checked).Message);
        await Assert.ThrowsAsync<DomainException>(async () => await handler.Handle(new("host", 1, false, Sig), _ct));
        Assert.Equal(["Invalid settings."], new UpdateSettingsCommandValidator().Validate(new UpdateSettingsCommand("c", 0, true, Sig)).Errors.Select(e => e.ErrorMessage));
    }

    [Fact]
    public async Task Ask_to_mute_goes_to_the_target_with_the_signed_request()
    {
        var bob = _rooms.Join("bob");

        var result = await new AskToMuteCommandHandler(_rooms, _verifier).Handle(new("host", bob.Id.Value, 4, Sig), _ct);

        Assert.Equal(new AskToMuteResult(_host.Id, "bob", 4, Sig), result);
        Assert.Equal(AdmissionMessages.Mute(_room, _host.Identity.Ed25519Pub, bob.Identity.Ed25519Pub, 4), Assert.Single(_verifier.Checked).Message);
        await Assert.ThrowsAsync<DomainException>(async () => await new AskToMuteCommandHandler(_rooms, _verifier).Handle(new("bob", _host.Id.Value, 5, Sig), _ct));
    }

    [Fact]
    public async Task End_call_empties_room_and_lobby()
    {
        _rooms.Join("bob");
        Waiting("guest");

        var result = await new EndCallCommandHandler(_rooms, _verifier, Metrics()).Handle(new("host", Sig), _ct);

        Assert.Equal(["host", "bob", "guest"], result.Connections);
        Assert.Equal(_host.Identity.Ed25519Pub, result.Issuer);
        Assert.Equal(new(0, 0), _rooms.Stats());
    }

    [Fact]
    public async Task Leaving_reports_members_and_lobby_guests_separately()
    {
        var guest = Waiting("guest");
        var handler = new LeaveRoomCommandHandler(_rooms);

        var leftLobby = await handler.Handle(new("guest"), _ct);
        Assert.Equal(guest.Id, leftLobby!.LeftLobby!.Id);
        Assert.Null(leftLobby.Left);

        var left = await handler.Handle(new("host"), _ct);
        Assert.Equal(_host.Id, left!.Left!.Id);
        Assert.Empty(left.Authority.Admitters);
        Assert.Null(await handler.Handle(new("host"), _ct));
    }

    private LobbyGuest Waiting(string connectionId) =>
        _rooms.Enter(_room, connectionId, room => room.EnterLobby(connectionId, TestIdentity.Distinct(connectionId), VideoCodecs.Baseline, _time.GetUtcNow()));

    private Application.Common.Telemetry.CipheroomMetrics Metrics() => TestMetrics.Create(_rooms).Metrics;
}
