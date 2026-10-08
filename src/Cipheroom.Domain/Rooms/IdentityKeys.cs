namespace Cipheroom.Domain.Rooms;

/// <summary>
/// A participant's public identity for end-to-end encryption, created by their browser for this call: Ed25519 and
/// X25519 public keys and the browser's self-signature over them, all base64url. Public keys only — the server
/// relays them but can't use them, and doesn't verify the self-signature (clients do; the server is untrusted).
/// </summary>
public sealed record IdentityKeys
{
    public const int PublicKeyBytes = Base64UrlBytes.PublicKeyBytes;
    public const int SignatureBytes = Base64UrlBytes.SignatureBytes;

    public IdentityKeys(string ed25519Pub, string x25519Pub, string sig)
    {
        // Last line of defence: user input is validated by FluentValidation in the Application layer.
        if (!IsValid(ed25519Pub, x25519Pub, sig))
            throw new ArgumentException("Invalid identity.");
        Ed25519Pub = ed25519Pub;
        X25519Pub = x25519Pub;
        Sig = sig;
    }

    public string Ed25519Pub { get; }

    public string X25519Pub { get; }

    public string Sig { get; }

    public static bool IsValid(string? ed25519Pub, string? x25519Pub, string? sig) =>
        Base64UrlBytes.IsPublicKey(ed25519Pub) && Base64UrlBytes.IsPublicKey(x25519Pub) && Base64UrlBytes.IsSignature(sig);
}
