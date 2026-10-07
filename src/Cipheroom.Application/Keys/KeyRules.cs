using System.Text.RegularExpressions;

namespace Cipheroom.Application.Keys;

/// <summary>Limits for relaying end-to-end key material (opaque envelopes only — the server can't read them).</summary>
public static partial class KeyRules
{
    /// <summary>One rotation is one call, to everyone else in the room.</summary>
    public const int MaxEnvelopesPerRequest = 64;

    /// <summary>Envelopes are ~550 characters; the client refuses anything larger too.</summary>
    public const int MaxBlobLength = 1024;

    public static bool IsBlob(string? blob) => blob is not null && BlobRegex().IsMatch(blob);

    // Upper bound = MaxBlobLength.
    [GeneratedRegex("^[A-Za-z0-9_-]{1,1024}$")]
    private static partial Regex BlobRegex();
}
