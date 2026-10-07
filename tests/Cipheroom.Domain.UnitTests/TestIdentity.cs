using Cipheroom.Domain.Rooms;

namespace Cipheroom.Domain.UnitTests;

/// <summary>A well-formed public identity (the server only checks shape: base64url of 32/32/64 bytes).</summary>
internal static class TestIdentity
{
    public const string Ed25519Pub = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    public const string X25519Pub = "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
    public const string Sig = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    public static IdentityKeys Keys => new(Ed25519Pub, X25519Pub, Sig);
}
