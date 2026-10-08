namespace Cipheroom.Application.Common.Interfaces;

/// <summary>Ed25519 signature checks for admission statements (public keys only — the server never signs anything).</summary>
public interface ISignatureVerifier
{
    /// <summary>False for a wrong signature as well as for a malformed key or signature.</summary>
    bool VerifyEd25519(ReadOnlySpan<byte> publicKey, ReadOnlySpan<byte> message, ReadOnlySpan<byte> signature);
}
