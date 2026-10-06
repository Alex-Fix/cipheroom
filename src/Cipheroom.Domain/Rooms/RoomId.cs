using System.Text.RegularExpressions;

namespace Cipheroom.Domain.Rooms;

/// <summary>Room identifier as it appears in invite links: lowercase letters, digits and dashes.</summary>
public sealed partial record RoomId
{
    public const int MinLength = 3;
    public const int MaxLength = 64;
    public const string Pattern = "^[a-z0-9-]{3,64}$";

    public RoomId(string value)
    {
        // Last line of defence: user input is validated by FluentValidation in the Application layer.
        if (value is null || !PatternRegex().IsMatch(value))
            throw new ArgumentException("Invalid room id.", nameof(value));
        Value = value;
    }

    public string Value { get; }

    public static bool IsValid(string? value) => value is not null && PatternRegex().IsMatch(value);

    public override string ToString() => Value;

    [GeneratedRegex(Pattern)]
    private static partial Regex PatternRegex();
}
