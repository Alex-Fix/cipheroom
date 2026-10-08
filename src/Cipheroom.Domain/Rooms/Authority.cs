namespace Cipheroom.Domain.Rooms;

/// <summary>What a participant may do in their room. Hosts and co-hosts are the room's admitters.</summary>
public enum ParticipantRole
{
    Guest,
    CoHost,
    Host,
}

/// <summary>
/// The room's host public keys (base64url). The room id is derived from them, so whoever holds the matching private
/// keys is the host — the server can't appoint one.
/// </summary>
public sealed record HostKeys(string Ed25519Pub, string X25519Pub);

/// <summary>The host key's signature binding a host's per-call identity (<paramref name="Identity"/>, Ed25519).</summary>
public sealed record HostAttestation(string Identity, string Sig);

/// <summary>
/// A signed statement by one per-call identity about another (Ed25519 public keys, base64url): an admission ticket,
/// a co-host grant or a removal. Verified by the server before it is stored and by every client again.
/// </summary>
public sealed record Statement(string Subject, string Issuer, string Sig);

/// <summary>Host-signed room settings; <paramref name="Seq"/> only goes up.</summary>
public sealed record RoomSettings(string Issuer, uint Seq, bool AutoAdmit, string Sig);

/// <summary>
/// Everything clients need to check who may do what in a room, from the host key down: host attestations, co-host
/// grants, removals and settings, plus who can admit right now. Public keys and signatures only.
/// </summary>
public sealed record RoomAuthority(
    HostKeys? Host,
    IReadOnlyList<HostAttestation> Hosts,
    IReadOnlyList<Statement> CoHosts,
    IReadOnlyList<Statement> Revoked,
    RoomSettings? Settings,
    IReadOnlyList<Participant> Admitters);
