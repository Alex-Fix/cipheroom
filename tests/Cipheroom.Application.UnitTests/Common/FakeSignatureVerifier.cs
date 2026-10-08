using Cipheroom.Application.Common.Interfaces;

namespace Cipheroom.Application.UnitTests.Common;

/// <summary>Accepts (or rejects) every signature and records what was checked. Real Ed25519 is tested in Infrastructure.</summary>
internal sealed class FakeSignatureVerifier : ISignatureVerifier
{
    public bool Valid { get; set; } = true;

    public List<(byte[] PublicKey, byte[] Message)> Checked { get; } = [];

    public bool VerifyEd25519(ReadOnlySpan<byte> publicKey, ReadOnlySpan<byte> message, ReadOnlySpan<byte> signature)
    {
        Checked.Add((publicKey.ToArray(), message.ToArray()));
        return Valid;
    }
}
