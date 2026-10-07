using System.Buffers.Text;
using System.Text.RegularExpressions;

namespace Cipheroom.Domain.Rooms;

/// <summary>
/// A participant's public identity for end-to-end encryption, created by their browser for this call: Ed25519 and
/// X25519 public keys and the browser's self-signature over them, all base64url. Public keys only — the server
/// relays them but can't use them, and doesn't verify the signature (clients do; the server is untrusted).
/// </summary>
public sealed partial record IdentityKeys
{
    public const int PublicKeyBytes = 32;
    public const int SignatureBytes = 64;

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
        IsBase64Url(ed25519Pub, PublicKeyBytes) && IsBase64Url(x25519Pub, PublicKeyBytes) && IsBase64Url(sig, SignatureBytes);

    /// <summary>Unpadded base64url of exactly <paramref name="bytes"/> bytes.</summary>
    private static bool IsBase64Url(string? value, int bytes) =>
        value is not null
        && value.Length == Base64Url.GetEncodedLength(bytes)
        && Base64UrlRegex().IsMatch(value)
        && Base64Url.IsValid(value, out var decoded)
        && decoded == bytes;

    [GeneratedRegex("^[A-Za-z0-9_-]+$")]
    private static partial Regex Base64UrlRegex();
}
