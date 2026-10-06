using System.Security.Cryptography;

namespace Cipheroom.Domain.Rooms;

/// <summary>Random public id for a participant, so transport connection ids never leave the server.</summary>
public sealed record ParticipantId
{
    public ParticipantId(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        Value = value;
    }

    public string Value { get; }

    /// <summary>64 random bits, lowercase hex.</summary>
    public static ParticipantId New() => new(Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8)));

    public override string ToString() => Value;
}
