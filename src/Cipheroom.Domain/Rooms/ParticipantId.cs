using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Cipheroom.Domain.Rooms;

/// <summary>Random public id for a participant, so transport connection ids never leave the server.</summary>
public sealed partial record ParticipantId
{
    public ParticipantId(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        Value = value;
    }

    public string Value { get; }

    /// <summary>64 random bits, lowercase hex.</summary>
    public static ParticipantId New() => new(Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8)));

    /// <summary>Shape of ids we issue; for validating ids sent back by clients.</summary>
    public static bool IsValid(string? value) => value is not null && PatternRegex().IsMatch(value);

    public override string ToString() => Value;

    [GeneratedRegex("^[0-9a-f]{16}$")]
    private static partial Regex PatternRegex();
}
