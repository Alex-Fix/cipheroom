namespace Cipheroom.Domain.Rooms;

/// <summary>Name shown to other participants. Stored trimmed.</summary>
public sealed record DisplayName
{
    public const int MaxLength = 64;

    public DisplayName(string value)
    {
        var trimmed = value?.Trim() ?? "";
        // Last line of defence: user input is validated by FluentValidation in the Application layer.
        if (!IsValid(trimmed))
            throw new ArgumentException("Display name must be 1-64 characters.", nameof(value));
        Value = trimmed;
    }

    public string Value { get; }

    public static bool IsValid(string? value) => value?.Trim().Length is > 0 and <= MaxLength;

    public override string ToString() => Value;
}
