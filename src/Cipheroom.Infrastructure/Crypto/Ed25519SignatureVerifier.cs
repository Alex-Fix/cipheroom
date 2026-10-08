using Cipheroom.Application.Common.Interfaces;
using Org.BouncyCastle.Math.EC.Rfc8032;

namespace Cipheroom.Infrastructure.Crypto;

/// <summary>Ed25519 (RFC 8032) verification on BouncyCastle — .NET has no built-in Ed25519.</summary>
public sealed class Ed25519SignatureVerifier : ISignatureVerifier
{
    public bool VerifyEd25519(ReadOnlySpan<byte> publicKey, ReadOnlySpan<byte> message, ReadOnlySpan<byte> signature)
    {
        if (publicKey.Length != Ed25519.PublicKeySize || signature.Length != Ed25519.SignatureSize)
            return false;
        try
        {
            return Ed25519.Verify(signature, publicKey, message);
        }
        catch (ArgumentException)
        {
            return false;
        }
    }
}
