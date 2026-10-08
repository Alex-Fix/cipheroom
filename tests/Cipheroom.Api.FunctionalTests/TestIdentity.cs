namespace Cipheroom.Api.FunctionalTests;

/// <summary>Well-formed public key material whose signatures the server doesn't check (X25519 key, self-signature).</summary>
internal static class TestIdentity
{
    public const string Ed25519Pub = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    public const string X25519Pub = "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
    public const string Sig = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    public static Hubs.Contracts.IdentityDto Dto => new(Ed25519Pub, X25519Pub, Sig);

    /// <summary>What a current browser sends with JoinLobby.</summary>
    public static string[] Codecs => ["vp8", "vp9"];
}
