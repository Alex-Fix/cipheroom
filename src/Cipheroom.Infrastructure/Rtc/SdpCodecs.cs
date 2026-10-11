using System.Text.RegularExpressions;

namespace Cipheroom.Infrastructure.Rtc;

/// <summary>
/// What a session description negotiates, reduced to what is safe to log: each media section's mid, kind and codec
/// names (<c>0:audio[opus] 1:video[VP9,VP8]</c>). Nothing else leaves the SDP — no payload types, fmtp, addresses,
/// ICE credentials or fingerprints — and anything that doesn't look like a mid or a codec name is replaced by <c>?</c>.
/// </summary>
public static partial class SdpCodecs
{
    public const int MaxSections = 64;
    public const int MaxLength = 1024;

    public static string Summary(string? sdp)
    {
        if (string.IsNullOrEmpty(sdp))
            return "none";

        var sections = new List<string>();
        foreach (var section in sdp.Split("\nm=").Skip(1).Take(MaxSections))
        {
            var lines = section.Split('\n').Select(l => l.TrimEnd('\r')).ToArray();
            var kind = Safe(lines[0].Split(' ')[0], Token());
            var mid = Safe(lines.FirstOrDefault(l => l.StartsWith("a=mid:", StringComparison.Ordinal))?[6..], Token());
            var codecs = lines
                .Where(l => l.StartsWith("a=rtpmap:", StringComparison.Ordinal))
                .Select(l => l.Split(' ') is [_, var encoding, ..] ? Safe(encoding.Split('/')[0], Token()) : "?")
                .Where(c => !Helper().IsMatch(c))
                .Distinct(StringComparer.OrdinalIgnoreCase);
            sections.Add($"{mid}:{kind}[{string.Join(',', codecs)}]");
        }

        var summary = sections.Count == 0 ? "none" : string.Join(' ', sections);
        return summary.Length <= MaxLength ? summary : summary[..MaxLength] + "…";
    }

    private static string Safe(string? value, Regex allowed) => value is not null && allowed.IsMatch(value) ? value : "?";

    [GeneratedRegex("^[A-Za-z0-9_-]{1,32}$")]
    private static partial Regex Token();

    // Retransmission and error-correction entries say nothing about which codec is missing.
    [GeneratedRegex("^(rtx|red|ulpfec|flexfec-03)$", RegexOptions.IgnoreCase)]
    private static partial Regex Helper();
}
