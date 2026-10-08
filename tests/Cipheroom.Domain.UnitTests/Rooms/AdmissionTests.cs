using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Domain.UnitTests.Rooms;

public sealed class AdmissionTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.UnixEpoch;
    private const string Sig = TestIdentity.Sig;

    private readonly Room _room = new(TestRooms.Id1);
    private readonly Participant _host;

    public AdmissionTests() => _host = _room.Join("host");

    [Fact]
    public void The_host_joins_straight_in_and_is_attested()
    {
        var authority = _room.Authority();
        Assert.Equal(TestRooms.HostKeys, authority.Host);
        Assert.Equal([new HostAttestation(_host.Identity.Ed25519Pub, Sig)], authority.Hosts);
        Assert.Equal([_host], authority.Admitters);
    }

    [Fact]
    public void A_different_host_key_is_refused()
    {
        var other = new HostKeys(TestIdentity.X25519Pub, TestIdentity.Ed25519Pub);
        var error = Assert.Throws<DomainException>(() =>
            _room.JoinAsHost("impostor", TestRooms.Identity("impostor"), VideoCodecs.Baseline, other, Sig));
        Assert.Equal("Invalid host proof.", error.Message);
    }

    [Fact]
    public void Guests_wait_in_the_lobby_until_admitted_with_a_ticket()
    {
        var guest = _room.EnterLobby("guest", TestRooms.Identity("guest"), VideoCodecs.Baseline, Now);
        Assert.Equal([guest], _room.Lobby);
        Assert.Null(_room.Find(guest.Id));

        var admitted = _room.Admit(_host.Id, guest.Id, Sig);

        Assert.Equal(guest.Id, admitted.Id);
        Assert.Equal(new Statement(guest.Identity.Ed25519Pub, _host.Identity.Ed25519Pub, Sig), admitted.Ticket);
        Assert.Equal(ParticipantRole.Guest, admitted.Role);
        Assert.Empty(_room.Lobby);
    }

    [Fact]
    public void Only_admitters_admit_deny_or_end()
    {
        var bob = _room.Join("bob");
        var guest = _room.EnterLobby("guest", TestRooms.Identity("guest"), VideoCodecs.Baseline, Now);

        Assert.Equal("Not allowed.", Assert.Throws<DomainException>(() => _room.Admit(bob.Id, guest.Id, Sig)).Message);
        Assert.Equal("Not allowed.", Assert.Throws<DomainException>(() => _room.Deny(bob.Id, guest.Id, Now)).Message);
        Assert.Equal("Not allowed.", Assert.Throws<DomainException>(() => _room.End(bob.Id)).Message);
    }

    [Fact]
    public void A_denied_connection_waits_before_asking_again()
    {
        var guest = _room.EnterLobby("guest", TestRooms.Identity("guest"), VideoCodecs.Baseline, Now);
        _room.Deny(_host.Id, guest.Id, Now);

        var error = Assert.Throws<DomainException>(() => _room.EnterLobby("guest", guest.Identity, VideoCodecs.Baseline, Now.AddSeconds(29)));
        Assert.Equal("Already asked, try again later.", error.Message);
        _room.EnterLobby("guest", guest.Identity, VideoCodecs.Baseline, Now + Room.DenyCooldown);
    }

    [Fact]
    public void The_lobby_is_capped()
    {
        for (var i = 0; i < Room.MaxLobby; i++)
            _room.EnterLobby($"g{i}", TestRooms.Identity($"g{i}"), VideoCodecs.Baseline, Now);

        var error = Assert.Throws<DomainException>(() => _room.EnterLobby("late", TestRooms.Identity("late"), VideoCodecs.Baseline, Now));
        Assert.Equal("Lobby is full.", error.Message);
    }

    [Fact]
    public void Knocks_go_to_admitters_only()
    {
        var bob = _room.Join("bob");
        var guest = _room.EnterLobby("guest", TestRooms.Identity("guest"), VideoCodecs.Baseline, Now);

        Assert.Equal([_host], _room.KnockRecipients(guest.Id, [_host.Id]));
        Assert.Equal("Invalid knock.", Assert.Throws<DomainException>(() => _room.KnockRecipients(guest.Id, [bob.Id])).Message);
    }

    [Fact]
    public void Co_hosts_can_admit_and_remove_guests_but_not_hosts_or_co_hosts()
    {
        var bob = _room.Join("bob");
        var carol = _room.Join("carol");
        var coHost = _room.GrantCoHost(_host.Id, bob.Id, Sig);
        Assert.Equal(ParticipantRole.CoHost, coHost.Role);
        Assert.Equal([_host, coHost], _room.Admitters);

        Assert.Equal("Not allowed.", Assert.Throws<DomainException>(() => _room.Remove(bob.Id, _host.Id, Sig)).Message);
        Assert.Equal("Not allowed.", Assert.Throws<DomainException>(() => _room.GrantCoHost(bob.Id, carol.Id, Sig)).Message);

        Assert.Equal(carol.Id, _room.Remove(bob.Id, carol.Id, Sig).Id);
        Assert.Null(_room.Find(carol.Id));
        Assert.Equal(
            [new Statement(carol.Identity.Ed25519Pub, bob.Identity.Ed25519Pub, Sig)],
            _room.Authority().Revoked);
    }

    [Fact]
    public void A_removed_identity_cannot_come_back()
    {
        var bob = _room.Join("bob");
        _room.Remove(_host.Id, bob.Id, Sig);

        var error = Assert.Throws<DomainException>(() => _room.EnterLobby("bob-again", bob.Identity, VideoCodecs.Baseline, Now));
        Assert.Equal("Not allowed.", error.Message);
        Assert.False(_room.CanRejoinWith(bob.Identity, bob.Ticket!));
    }

    [Fact]
    public void Admitted_identities_rejoin_with_their_ticket_and_keep_their_role()
    {
        var bob = _room.Join("bob");
        _room.GrantCoHost(_host.Id, bob.Id, Sig);
        _room.Leave("bob");

        Assert.True(_room.CanRejoinWith(bob.Identity, bob.Ticket!));
        var back = _room.JoinWithTicket("bob-2", bob.Identity, VideoCodecs.Baseline, bob.Ticket!);
        Assert.Equal(ParticipantRole.CoHost, back.Role);

        var forged = bob.Ticket! with { Issuer = TestRooms.Identity("nobody").Ed25519Pub };
        Assert.False(_room.CanRejoinWith(bob.Identity, forged));
    }

    [Fact]
    public void Settings_only_move_forward_and_only_the_host_sets_them()
    {
        var bob = _room.Join("bob");
        _room.UpdateSettings(_host.Id, 1, true, Sig);

        Assert.Equal("Not allowed.", Assert.Throws<DomainException>(() => _room.UpdateSettings(_host.Id, 1, false, Sig)).Message);
        Assert.Equal("Not allowed.", Assert.Throws<DomainException>(() => _room.UpdateSettings(bob.Id, 2, false, Sig)).Message);
        Assert.True(_room.Settings!.AutoAdmit);
    }

    [Fact]
    public void Ending_the_call_empties_room_and_lobby()
    {
        var bob = _room.Join("bob");
        _room.EnterLobby("guest", TestRooms.Identity("guest"), VideoCodecs.Baseline, Now);

        Assert.Equal(["host", "bob", "guest"], _room.End(_host.Id));
        Assert.True(_room.IsEmpty);
        Assert.NotNull(bob);
    }
}
