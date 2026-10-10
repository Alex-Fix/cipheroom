using System.Text.RegularExpressions;

namespace Cipheroom.Application.Chat;

/// <summary>
/// Limits for relaying end-to-end encrypted chat events (messages and reactions alike — the server can't tell them
/// apart). Blobs are padded by the browser to fixed sizes; the largest (16 KB of plaintext) is 21,886 characters.
/// </summary>
public static partial class ChatRules
{
    public const string InvalidMessage = "Invalid chat message.";

    public const int MaxBlobLength = 22528;

    public static bool IsBlob(string? blob) => blob is not null && BlobRegex().IsMatch(blob);

    // Upper bound = MaxBlobLength.
    [GeneratedRegex("^[A-Za-z0-9_-]{1,22528}$")]
    private static partial Regex BlobRegex();
}
