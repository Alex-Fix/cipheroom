using System.Threading.Channels;
using Cipheroom.Api.Hubs.Contracts;
using Cipheroom.Application.Admission;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using static Cipheroom.Api.FunctionalTests.TestCall;

namespace Cipheroom.Api.FunctionalTests;

/// <summary>
/// The lobby and host controls as clients see them (docs/plans/2026-10-08-lobby-admission-design.md): only the host
/// key or a signed ticket gets anyone in, lobby guests see and reach nothing, and every control is a checked signature.
/// </summary>
public sealed class LobbyHubTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory = factory.WithWebHostBuilder(b => b
        .UseSetting("Turn:Cloudflare:KeyId", "")
        .UseSetting("Turn:Cloudflare:ApiToken", "")
        .UseSetting("RateLimiting:Hub:TokenLimit", "1000")
        .UseSetting("RateLimiting:Hub:TokensPerSecond", "1000"));

    private readonly TestRoom _room = new();

    [Fact]
    public async Task Guests_wait_see_nobody_and_reach_nothing()
    {
        await using var alice = await ConnectAsync();
        await using var guestConnection = await ConnectAsync();
        var joined = Events<ParticipantDto>(alice, "ParticipantJoined");
        var host = await _room.HostAsync(alice);

        var guest = await _room.WaitAsync(guestConnection);

        Assert.False(guest.Join.Admitted);
        Assert.Empty(guest.Join.Participants);
        Assert.Equal(host.SelfId, Assert.Single(guest.Join.Authority.Admitters).Id);
        await AssertHubErrorAsync("Not admitted.", () => guestConnection.InvokeAsync<RtcConfig>("GetRtcConfig", Ct));
        await AssertHubErrorAsync("Not admitted.", () =>
            guestConnection.InvokeAsync("SendKeyEnvelopes", new[] { new KeyEnvelopeDto(host.SelfId, "aGk") }, Ct));
        await AssertHubErrorAsync("Not admitted.", () =>
            guestConnection.InvokeAsync<SubscribeResult>("SubscribeTracks", new[] { new TrackRefDto(host.SelfId, "camera") }, Ct));
        Assert.False(joined.TryRead(out _));
    }

    [Fact]
    public async Task The_host_learns_of_the_room_and_the_lobby_hears_when_admitters_arrive()
    {
        await using var guestConnection = await ConnectAsync();
        await using var alice = await ConnectAsync();
        var authority = Events<AuthorityDto>(guestConnection, "AuthorityUpdated");

        var guest = await _room.WaitAsync(guestConnection);
        Assert.Empty(guest.Join.Authority.Admitters);
        Assert.Null(guest.Join.Authority.HostEd25519Pub);

        var host = await _room.HostAsync(alice);
        var update = await authority.ReadAsync(Timeout());
        Assert.Equal(_room.HostKey.Pub, update.HostEd25519Pub);
        Assert.Equal(_room.HostX25519Pub, update.HostX25519Pub);
        Assert.Equal(host.SelfId, Assert.Single(update.Admitters).Id);
        Assert.Equal(new HostAttestationDto(host.Identity.Pub, _room.ProofFor(host.Identity).Attestation!), Assert.Single(update.Hosts));
    }

    [Fact]
    public async Task A_host_proof_has_to_match_the_room_and_the_identity()
    {
        await using var connection = await ConnectAsync();
        var identity = new TestSigner();
        var otherRoomsProof = new TestRoom().ProofFor(identity);
        var proofForSomeoneElse = _room.ProofFor(new TestSigner());

        foreach (var proof in new[] { otherRoomsProof, proofForSomeoneElse })
        {
            await AssertHubErrorAsync("Invalid host proof.", () =>
                connection.InvokeAsync<LobbyResult>("JoinLobby", _room.Id, identity.Identity, TestIdentity.Codecs, proof, null, Ct));
        }
    }

    [Fact]
    public async Task Knocks_reach_admitters_only_with_the_guests_identity()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        await using var guestConnection = await ConnectAsync();
        var knocks = Events<LobbyGuestDto, string>(alice, "KnockReceived");
        var host = await _room.HostAsync(alice);
        var member = await _room.AdmitAsync(host, bob);
        var guest = await _room.WaitAsync(guestConnection);

        await guestConnection.InvokeAsync("Knock", new[] { new KnockDto(host.SelfId, "bmFtZQ") }, Ct);

        var knock = await knocks.ReadAsync(Timeout());
        Assert.Equal((new LobbyGuestDto(guest.SelfId, guest.Identity.Identity), "bmFtZQ"), knock);
        await AssertHubErrorAsync("Invalid knock.", () => guestConnection.InvokeAsync("Knock", new[] { new KnockDto(member.SelfId, "bmFtZQ") }, Ct));
        await AssertHubErrorAsync("Not allowed.", () => bob.InvokeAsync("Knock", new[] { new KnockDto(host.SelfId, "bmFtZQ") }, Ct));
    }

    [Fact]
    public async Task Admission_needs_an_admitter_and_a_valid_ticket()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        await using var guestConnection = await ConnectAsync();
        var host = await _room.HostAsync(alice);
        var member = await _room.AdmitAsync(host, bob);
        var guest = await _room.WaitAsync(guestConnection);

        // Bob isn't an admitter; a ticket signed by someone else's key or for someone else doesn't verify.
        await AssertHubErrorAsync("Not allowed.", () => bob.InvokeAsync("Admit", guest.SelfId, _room.TicketFor(member, guest.Identity), Ct));
        await AssertHubErrorAsync("Invalid signature.", () => alice.InvokeAsync("Admit", guest.SelfId, _room.TicketFor(member, guest.Identity), Ct));
        await AssertHubErrorAsync("Invalid signature.", () => alice.InvokeAsync("Admit", guest.SelfId, _room.TicketFor(host, member.Identity), Ct));
        await AssertHubErrorAsync("Not admitted.", () => guestConnection.InvokeAsync<RtcConfig>("GetRtcConfig", Ct));
    }

    [Fact]
    public async Task Denied_guests_hear_so_and_wait_before_asking_again()
    {
        await using var alice = await ConnectAsync();
        await using var guestConnection = await ConnectAsync();
        var lobbyLeft = Events<string>(alice, "LobbyLeft");
        var denied = Channel.CreateUnbounded<bool>();
        guestConnection.On("Denied", () => denied.Writer.TryWrite(true));
        await _room.HostAsync(alice);
        var guest = await _room.WaitAsync(guestConnection);

        await alice.InvokeAsync("Deny", guest.SelfId, Ct);

        Assert.True(await denied.Reader.ReadAsync(Timeout()));
        Assert.Equal(guest.SelfId, await lobbyLeft.ReadAsync(Timeout()));
        await AssertHubErrorAsync("Already asked, try again later.", () => _room.WaitAsync(guestConnection));
    }

    [Fact]
    public async Task A_ticket_from_earlier_in_the_call_skips_the_lobby()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        var host = await _room.HostAsync(alice);
        var guest = await _room.AdmitAsync(host, bob);
        await bob.InvokeAsync("LeaveRoom", Ct);

        var ticket = guest.Join.Ticket;
        Assert.Equal(new TicketDto(host.Identity.Pub, _room.TicketFor(host, guest.Identity)), ticket);
        var back = await bob.InvokeAsync<LobbyResult>("JoinLobby", _room.Id, guest.Identity.Identity, TestIdentity.Codecs, null, ticket, Ct);

        Assert.True(back.Admitted);
        Assert.Equal(host.SelfId, Assert.Single(back.Participants).Id);
    }

    [Fact]
    public async Task Co_hosts_admit_but_cannot_remove_the_host()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        await using var carol = await ConnectAsync();
        var host = await _room.HostAsync(alice);
        var member = await _room.AdmitAsync(host, bob);

        await alice.InvokeAsync("GrantCoHost", member.SelfId,
            host.Identity.Sign(AdmissionMessages.CoHost(_room.RoomId, host.Identity.Pub, member.Identity.Pub)), Ct);
        var coHost = member;
        var guest = await _room.AdmitAsync(coHost, carol);

        Assert.True(guest.Join.Admitted);
        Assert.Equal(new StatementDto(member.Identity.Pub, host.Identity.Pub, host.Identity.Sign(AdmissionMessages.CoHost(_room.RoomId, host.Identity.Pub, member.Identity.Pub))),
            Assert.Single(guest.Join.Authority.CoHosts));
        await AssertHubErrorAsync("Not allowed.", () => bob.InvokeAsync("RemoveParticipant", host.SelfId,
            member.Identity.Sign(AdmissionMessages.Revoke(_room.RoomId, member.Identity.Pub, host.Identity.Pub)), Ct));
    }

    [Fact]
    public async Task Removed_participants_are_out_for_good()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        var removed = Channel.CreateUnbounded<bool>();
        bob.On("Removed", () => removed.Writer.TryWrite(true));
        var left = Events<string>(alice, "ParticipantLeft");
        var authority = Events<AuthorityDto>(alice, "AuthorityUpdated");
        var host = await _room.HostAsync(alice);
        var member = await _room.AdmitAsync(host, bob);

        var revocation = host.Identity.Sign(AdmissionMessages.Revoke(_room.RoomId, host.Identity.Pub, member.Identity.Pub));
        await alice.InvokeAsync("RemoveParticipant", member.SelfId, revocation, Ct);

        Assert.True(await removed.Reader.ReadAsync(Timeout()));
        Assert.Equal(member.SelfId, await left.ReadAsync(Timeout()));
        Assert.Equal(new StatementDto(member.Identity.Pub, host.Identity.Pub, revocation), Assert.Single((await NextAsync(authority, a => a.Revoked.Count > 0)).Revoked));
        await AssertHubErrorAsync("Join a room first.", () => bob.InvokeAsync<RtcConfig>("GetRtcConfig", Ct));

        var ticket = new TicketDto(host.Identity.Pub, _room.TicketFor(host, member.Identity));
        await AssertHubErrorAsync("Not allowed.", () =>
            bob.InvokeAsync<LobbyResult>("JoinLobby", _room.Id, member.Identity.Identity, TestIdentity.Codecs, null, ticket, Ct));
    }

    [Fact]
    public async Task Settings_and_mute_requests_are_signed()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        var authority = Events<AuthorityDto>(alice, "AuthorityUpdated");
        var mutes = Channel.CreateUnbounded<(string, long, string)>();
        bob.On<string, long, string>("MuteRequested", (from, seq, sig) => mutes.Writer.TryWrite((from, seq, sig)));
        var host = await _room.HostAsync(alice);
        var member = await _room.AdmitAsync(host, bob);

        var settings = host.Identity.Sign(AdmissionMessages.Settings(_room.RoomId, host.Identity.Pub, 1, true));
        await alice.InvokeAsync("UpdateSettings", 1L, true, settings, Ct);
        Assert.Equal(new SettingsDto(host.Identity.Pub, 1, true, settings), (await NextAsync(authority, a => a.Settings is not null)).Settings);
        await AssertHubErrorAsync("Invalid signature.", () => alice.InvokeAsync("UpdateSettings", 2L, false, settings, Ct));

        var mute = host.Identity.Sign(AdmissionMessages.Mute(_room.RoomId, host.Identity.Pub, member.Identity.Pub, 1));
        await alice.InvokeAsync("AskToMute", member.SelfId, 1L, mute, Ct);
        Assert.Equal((host.SelfId, 1L, mute), await mutes.Reader.ReadAsync(Timeout()));
    }

    [Fact]
    public async Task Ending_the_call_reaches_everyone_including_the_lobby()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        await using var guestConnection = await ConnectAsync();
        var ended = Events<string, string>(bob, "CallEnded");
        var lobbyEnded = Events<string, string>(guestConnection, "CallEnded");
        var host = await _room.HostAsync(alice);
        await _room.AdmitAsync(host, bob);
        await _room.WaitAsync(guestConnection);

        var end = host.Identity.Sign(AdmissionMessages.End(_room.RoomId, host.Identity.Pub));
        await alice.InvokeAsync("EndCall", end, Ct);

        Assert.Equal((host.Identity.Pub, end), await ended.ReadAsync(Timeout()));
        Assert.Equal((host.Identity.Pub, end), await lobbyEnded.ReadAsync(Timeout()));
        await AssertHubErrorAsync("Join a room first.", () => alice.InvokeAsync<RtcConfig>("GetRtcConfig", Ct));
        await AssertHubErrorAsync("Join a room first.", () => bob.InvokeAsync<RtcConfig>("GetRtcConfig", Ct));
    }

    /// <summary>The first event matching <paramref name="match"/> (earlier ones, e.g. our own arrival, are skipped).</summary>
    private static async Task<T> NextAsync<T>(ChannelReader<T> events, Func<T, bool> match)
    {
        var timeout = Timeout();
        while (true)
        {
            var next = await events.ReadAsync(timeout);
            if (match(next))
                return next;
        }
    }

    private static async Task AssertHubErrorAsync(string expectedMessage, Func<Task> call)
    {
        var error = await Assert.ThrowsAsync<HubException>(call);
        Assert.EndsWith($"HubException: {expectedMessage}", error.Message, StringComparison.Ordinal);
    }

    private async Task<HubConnection> ConnectAsync()
    {
        var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(_factory.Server.BaseAddress, "hubs/room"), o =>
            {
                o.Transports = HttpTransportType.LongPolling;
                o.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
            })
            .Build();
        await connection.StartAsync(Ct);
        return connection;
    }
}
