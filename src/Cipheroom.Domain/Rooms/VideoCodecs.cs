namespace Cipheroom.Domain.Rooms;

/// <summary>
/// Video codecs a participant's browser can decode, relayed so senders pick one everyone can play. Always includes
/// VP8, the baseline every client decodes. Public, unsigned data: tampering can only cost bandwidth or break a
/// viewer's video, never decrypt anything (frames are end-to-end encrypted whatever the codec).
/// </summary>
public sealed record VideoCodecs
{
    public const string Vp8 = "vp8";
    public const string Vp9 = "vp9";

    /// <summary>Known codecs in canonical order (how <see cref="Values"/> is stored).</summary>
    public static readonly IReadOnlyList<string> Known = [Vp8, Vp9];

    public static VideoCodecs Baseline { get; } = new([Vp8]);

    public VideoCodecs(IReadOnlyCollection<string> values)
    {
        // Last line of defence: user input is validated by FluentValidation in the Application layer.
        if (!IsValid(values))
            throw new ArgumentException("Invalid video codecs.", nameof(values));
        Values = [.. Known.Where(values.Contains)];
    }

    public IReadOnlyList<string> Values { get; }

    /// <summary>1–2 distinct known codecs, VP8 among them.</summary>
    public static bool IsValid(IReadOnlyCollection<string?>? values) =>
        values is { Count: > 0 } && values.Count <= Known.Count
        && values.All(v => v is not null && Known.Contains(v))
        && values.Distinct().Count() == values.Count
        && values.Contains(Vp8);

    public bool Equals(VideoCodecs? other) => other is not null && Values.SequenceEqual(other.Values);

    public override int GetHashCode() => string.Join(',', Values).GetHashCode(StringComparison.Ordinal);

    public override string ToString() => string.Join(',', Values);
}
