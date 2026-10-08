using Cipheroom.Application.Admission;
using Cipheroom.Application.Admission.Commands.JoinLobby;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Application.UnitTests;

/// <summary>Well-formed public keys (the domain only checks shape: base64url of 32/32/64 bytes) and room ids.</summary>
internal static class TestIdentity
{
    public const string Ed25519Pub = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    public const string X25519Pub = "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
    public const string Sig = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    public static IdentityKeys Keys => new(Ed25519Pub, X25519Pub, Sig);

    public static IdentityInput Input => new(Ed25519Pub, X25519Pub, Sig);

    public static HostKeys Host => new(Ed25519Pub, X25519Pub);

    /// <summary>The id a room hosted with <see cref="Host"/> has.</summary>
    public static string HostedRoom => AdmissionMessages.RoomIdFor(Host);

    /// <summary>What a current browser sends with JoinLobby.</summary>
    public static IReadOnlyList<string?> Codecs => ["vp8", "vp9"];

    /// <summary>A valid room id per short alias ("room-1", "room-2").</summary>
    public static RoomId Room(string alias) => new(new string((char)('a' + alias.Sum(c => c) % 26), 26));

    /// <summary>An identity whose Ed25519 key differs per seed (authority rules go by identity).</summary>
    public static IdentityKeys Distinct(string seed)
    {
        var chars = new string([.. seed.Where(char.IsAsciiLetterOrDigit)]);
        return new((chars + new string('A', 43))[..42] + "A", X25519Pub, Sig);
    }
}
