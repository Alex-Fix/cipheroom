using System.Text.RegularExpressions;

namespace Cipheroom.Application.Keys;

/// <summary>Limits for relaying end-to-end key material (opaque envelopes only — the server can't read them).</summary>
public static partial class KeyRules
{
    /// <summary>One rotation is one call, to everyone else in the room.</summary>
    public const int MaxEnvelopesPerRequest = 64;

    /// <summary>Envelopes (v2: sender key + padded name) are ~1,000 characters; the client refuses anything larger too.</summary>
    public const int MaxBlobLength = 2048;

    public static bool IsBlob(string? blob) => blob is not null && BlobRegex().IsMatch(blob);

    // Upper bound = MaxBlobLength.
    [GeneratedRegex("^[A-Za-z0-9_-]{1,2048}$")]
    private static partial Regex BlobRegex();
}
