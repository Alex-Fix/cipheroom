using System.Text.RegularExpressions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Common;

namespace Cipheroom.Application.Files;

/// <summary>
/// Limits for the data channels that carry end-to-end encrypted files (docs/plans/2026-10-10-encrypted-files-design.md).
/// The server never sees file bytes or sizes — they go browser ⇄ Cloudflare — so the lifetime and the per-participant
/// counts (in <see cref="Domain.Rooms.Room"/>) are what bounds a modified client burning free-tier traffic.
/// </summary>
public static partial class FileRules
{
    public const string FileSharingPaused = "File sharing is paused.";

    /// <summary>The api closes every data channel this long after it was opened (a 100 MB file needs ~3 Mbps).</summary>
    public static readonly TimeSpan ChannelLifetime = TimeSpan.FromMinutes(5);

    /// <summary>Client channel names: 16 random bytes as base64url (22 characters).</summary>
    public static bool IsChannelName(string? name) => name is not null && NameRegex().IsMatch(name);

    /// <summary>New transfers need the usage guard below audio-only; ones already running finish.</summary>
    public static void EnsureAllowed(IUsageGuard usage)
    {
        if (usage.Current.Level >= UsageLevel.AudioOnly)
            throw new DomainException(FileSharingPaused);
    }

    [GeneratedRegex("^[A-Za-z0-9_-]{22}$")]
    private static partial Regex NameRegex();
}
