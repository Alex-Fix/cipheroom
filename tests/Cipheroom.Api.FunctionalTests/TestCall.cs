using System.Buffers.Text;
using System.Security.Cryptography;
using System.Threading.Channels;
using Cipheroom.Api.Hubs.Contracts;
using Cipheroom.Application.Admission;
using Cipheroom.Domain.Rooms;
using Microsoft.AspNetCore.SignalR.Client;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Security;

namespace Cipheroom.Api.FunctionalTests;

/// <summary>A real Ed25519 key, as a browser's per-call identity or host key would hold (the server verifies signatures).</summary>
internal sealed class TestSigner
{
    private readonly Ed25519PrivateKeyParameters _key = new(new SecureRandom());

    public TestSigner() => Pub = Base64Url.EncodeToString(_key.GeneratePublicKey().GetEncoded());

    public string Pub { get; }

    /// <summary>The public identity a browser sends (the X25519 key and self-signature aren't checked by the server).</summary>
    public IdentityDto Identity => new(Pub, TestIdentity.X25519Pub, TestIdentity.Sig);

    public string Sign(byte[] message)
    {
        var signature = new byte[Ed25519PrivateKeyParameters.SignatureSize];
        _key.Sign(Org.BouncyCastle.Math.EC.Rfc8032.Ed25519.Algorithm.Ed25519, null, message, 0, message.Length, signature, 0);
        return Base64Url.EncodeToString(signature);
    }
}

/// <summary>Someone in a call: their connection, identity key and what joining returned.</summary>
internal sealed record TestMember(HubConnection Connection, TestSigner Identity, LobbyResult Join)
{
    public string SelfId => Join.SelfId;
}

/// <summary>
/// A meeting: a host key and the room id derived from it, plus the client steps to host it or get admitted to it.
/// </summary>
internal sealed class TestRoom
{
    public TestSigner HostKey { get; } = new();

    public string HostX25519Pub { get; } = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));

    public string Id => AdmissionMessages.RoomIdFor(new HostKeys(HostKey.Pub, HostX25519Pub));

    public RoomId RoomId => new(Id);

    public HostProofDto ProofFor(TestSigner identity) =>
        new(HostKey.Pub, HostX25519Pub, HostKey.Sign(AdmissionMessages.Host(RoomId, identity.Pub)));

    public async Task<TestMember> HostAsync(HubConnection connection, string[]? codecs = null)
    {
        var identity = new TestSigner();
        var join = await connection.InvokeAsync<LobbyResult>(
            "JoinLobby", Id, identity.Identity, codecs ?? TestIdentity.Codecs, ProofFor(identity), null, TestCall.Ct);
        return new TestMember(connection, identity, join);
    }

    /// <summary>Joins the lobby as a new identity (not yet admitted).</summary>
    public async Task<TestMember> WaitAsync(HubConnection connection, string[]? codecs = null)
    {
        var identity = new TestSigner();
        var join = await connection.InvokeAsync<LobbyResult>("JoinLobby", Id, identity.Identity, codecs ?? TestIdentity.Codecs, null, null, TestCall.Ct);
        return new TestMember(connection, identity, join);
    }

    public string TicketFor(TestMember admitter, TestSigner guest) =>
        admitter.Identity.Sign(AdmissionMessages.Ticket(RoomId, admitter.Identity.Pub, guest.Pub));

    /// <summary>Waits in the lobby, gets a ticket from <paramref name="admitter"/>, and returns once in the call.</summary>
    public async Task<TestMember> AdmitAsync(TestMember admitter, HubConnection guest, string[]? codecs = null)
    {
        var admitted = Channel.CreateUnbounded<LobbyResult>();
        using var subscription = guest.On<LobbyResult>("Admitted", r => admitted.Writer.TryWrite(r));
        var waiting = await WaitAsync(guest, codecs);

        await admitter.Connection.InvokeAsync("Admit", waiting.SelfId, TicketFor(admitter, waiting.Identity), TestCall.Ct);
        return waiting with { Join = await admitted.Reader.ReadAsync(TestCall.Timeout()) };
    }
}

internal static class TestCall
{
    public static CancellationToken Ct => TestContext.Current.CancellationToken;

    public static CancellationToken Timeout() =>
        CancellationTokenSource.CreateLinkedTokenSource(Ct, new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token).Token;

    /// <summary>Collects one kind of server event.</summary>
    public static ChannelReader<T> Events<T>(HubConnection connection, string name)
    {
        var events = Channel.CreateUnbounded<T>();
        connection.On<T>(name, e => events.Writer.TryWrite(e));
        return events.Reader;
    }

    /// <summary>Collects one kind of two-argument server event.</summary>
    public static ChannelReader<(TFirst, TSecond)> Events<TFirst, TSecond>(HubConnection connection, string name)
    {
        var events = Channel.CreateUnbounded<(TFirst, TSecond)>();
        connection.On<TFirst, TSecond>(name, (a, b) => events.Writer.TryWrite((a, b)));
        return events.Reader;
    }
}
