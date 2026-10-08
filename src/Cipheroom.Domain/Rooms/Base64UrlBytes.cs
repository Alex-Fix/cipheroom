using System.Buffers.Text;
using System.Text.RegularExpressions;

namespace Cipheroom.Domain.Rooms;

/// <summary>Shape checks for the public keys and signatures clients send: unpadded base64url of an exact size.</summary>
public static partial class Base64UrlBytes
{
    public const int PublicKeyBytes = 32;
    public const int SignatureBytes = 64;

    /// <summary>Unpadded base64url of exactly <paramref name="bytes"/> bytes.</summary>
    public static bool Is(string? value, int bytes) =>
        value is not null
        && value.Length == Base64Url.GetEncodedLength(bytes)
        && Base64UrlRegex().IsMatch(value)
        && Base64Url.IsValid(value, out var decoded)
        && decoded == bytes;

    public static bool IsPublicKey(string? value) => Is(value, PublicKeyBytes);

    public static bool IsSignature(string? value) => Is(value, SignatureBytes);

    [GeneratedRegex("^[A-Za-z0-9_-]+$")]
    private static partial Regex Base64UrlRegex();
}
