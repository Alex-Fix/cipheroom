using System.Buffers.Binary;
using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Application.Admission;

/// <summary>
/// The exact bytes every admission statement signs, byte-identical to the browser's
/// <c>web/src/app/core/crypto/encoding.ts</c> (<c>fields</c>) and <c>statements.ts</c> — pinned by shared test vectors.
/// Each message starts with its own label (domain separation) and the room id, so a statement can't be reused for
/// another purpose or room. Design: docs/plans/2026-10-08-lobby-admission-design.md.
/// </summary>
public static class AdmissionMessages
{
    public const string RoomLabel = "cipheroom/room/v1";
    public const string HostLabel = "cipheroom/host/v1";
    public const string CoHostLabel = "cipheroom/cohost/v1";
    public const string TicketLabel = "cipheroom/ticket/v1";
    public const string RevokeLabel = "cipheroom/revoke/v1";
    public const string SettingsLabel = "cipheroom/settings/v1";
    public const string EndLabel = "cipheroom/end/v1";
    public const string MuteLabel = "cipheroom/mute/v1";

    /// <summary>Characters of the room id: 26 × 5 = 130 bits of SHA-256.</summary>
    public const int RoomIdLength = 26;

    private const string Base32Alphabet = "abcdefghijklmnopqrstuvwxyz234567";

    /// <summary>The room id the host public keys commit to: base32 (lowercase, RFC 4648 alphabet) of SHA-256, truncated.</summary>
    public static string RoomIdFor(HostKeys keys)
    {
        var hash = SHA256.HashData(Fields(RoomLabel, Key(keys.Ed25519Pub), Key(keys.X25519Pub)));
        return Base32(hash)[..RoomIdLength];
    }

    public static byte[] Host(RoomId roomId, string identity) => Fields(HostLabel, roomId.Value, Key(identity));

    public static byte[] CoHost(RoomId roomId, string issuer, string subject) => Fields(CoHostLabel, roomId.Value, Key(issuer), Key(subject));

    public static byte[] Ticket(RoomId roomId, string issuer, string subject) => Fields(TicketLabel, roomId.Value, Key(issuer), Key(subject));

    public static byte[] Revoke(RoomId roomId, string issuer, string subject) => Fields(RevokeLabel, roomId.Value, Key(issuer), Key(subject));

    public static byte[] Settings(RoomId roomId, string issuer, uint seq, bool autoAdmit) =>
        Fields(SettingsLabel, roomId.Value, Key(issuer), seq, autoAdmit ? 1u : 0u);

    public static byte[] End(RoomId roomId, string issuer) => Fields(EndLabel, roomId.Value, Key(issuer));

    public static byte[] Mute(RoomId roomId, string issuer, string subject, uint seq) => Fields(MuteLabel, roomId.Value, Key(issuer), Key(subject), seq);

    /// <summary>Throws <see cref="DomainException"/> ("Invalid signature.") unless <paramref name="sig"/> verifies.</summary>
    public static void Verify(ISignatureVerifier verifier, string publicKey, byte[] message, string sig)
    {
        if (!verifier.VerifyEd25519(Key(publicKey), message, Base64Url.DecodeFromChars(sig)))
            throw new DomainException(AdmissionRules.InvalidSignature);
    }

    /// <summary>
    /// Unambiguous encoding: each field as a 4-byte big-endian length, then its bytes (strings UTF-8, numbers 4-byte
    /// big-endian unsigned). Same as the browser's <c>fields(...)</c>.
    /// </summary>
    public static byte[] Fields(params object[] parts)
    {
        var encoded = parts.Select(p => p switch
        {
            string s => Encoding.UTF8.GetBytes(s),
            uint n => BigEndian(n),
            byte[] b => b,
            _ => throw new ArgumentException("Unsupported field type.", nameof(parts)),
        }).ToArray();

        var output = new byte[encoded.Sum(e => 4 + e.Length)];
        var offset = 0;
        foreach (var part in encoded)
        {
            BinaryPrimitives.WriteUInt32BigEndian(output.AsSpan(offset), (uint)part.Length);
            part.CopyTo(output, offset + 4);
            offset += 4 + part.Length;
        }
        return output;
    }

    private static byte[] Key(string base64Url) => Base64Url.DecodeFromChars(base64Url);

    private static byte[] BigEndian(uint n)
    {
        var bytes = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(bytes, n);
        return bytes;
    }

    private static string Base32(ReadOnlySpan<byte> data)
    {
        var output = new StringBuilder((data.Length * 8 + 4) / 5);
        int buffer = 0, bits = 0;
        foreach (var b in data)
        {
            buffer = ((buffer & 0xff) << 8) | b;
            bits += 8;
            while (bits >= 5)
            {
                output.Append(Base32Alphabet[(buffer >> (bits - 5)) & 31]);
                bits -= 5;
            }
        }
        if (bits > 0)
            output.Append(Base32Alphabet[(buffer << (5 - bits)) & 31]);
        return output.ToString();
    }
}
