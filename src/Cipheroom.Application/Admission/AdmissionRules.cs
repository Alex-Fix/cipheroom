using System.Text.RegularExpressions;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Application.Admission;

/// <summary>Input limits and constant client messages for the lobby and host controls.</summary>
public static partial class AdmissionRules
{
    public const string InvalidSignature = "Invalid signature.";
    public const string InvalidHostProof = Room.InvalidHostProof;
    public const string InvalidParticipant = "Invalid participant.";
    public const string InvalidSettings = "Invalid settings.";

    /// <summary>A knock goes to each admitter online (hosts and co-hosts).</summary>
    public const int MaxKnocksPerRequest = 16;

    /// <summary>Knocks carry a padded, encrypted name (~800 characters); the client refuses anything larger too.</summary>
    public const int MaxKnockBlobLength = 2048;

    public static bool IsKnockBlob(string? blob) => blob is not null && KnockBlobRegex().IsMatch(blob);

    // Upper bound = MaxKnockBlobLength.
    [GeneratedRegex("^[A-Za-z0-9_-]{1,2048}$")]
    private static partial Regex KnockBlobRegex();
}
