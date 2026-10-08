using System.Text.RegularExpressions;

namespace Cipheroom.Domain.Rooms;

/// <summary>
/// Room identifier as it appears in invite links: 26 lowercase base32 characters derived from the room's host public
/// keys (see Application <c>AdmissionMessages.RoomIdFor</c>), so the link itself says who the host is.
/// </summary>
public sealed partial record RoomId
{
    public const int Length = 26;
    public const string Pattern = "^[a-z2-7]{26}$";

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
