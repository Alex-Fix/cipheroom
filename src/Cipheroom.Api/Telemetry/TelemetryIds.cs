using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;

namespace Cipheroom.Api.Telemetry;

public sealed class TelemetryOptions
{
    public const string Section = "Telemetry";

    /// <summary>
    /// Key for pseudonymous room ids in logs and traces (deploy/.env <c>TELEMETRY_SECRET</c>). Empty: a random key
    /// per process — still pseudonymous, but the same room hashes differently after a restart.
    /// </summary>
    public string Secret { get; set; } = "";
}

/// <summary>
/// Pseudonymous ids for logs and traces: a room id never reaches telemetry in plain text ("mom-and-me"), only a keyed
/// hash, so one call can still be followed without recording what people named their rooms.
/// </summary>
public sealed class TelemetryIds(IOptions<TelemetryOptions> options)
{
    private readonly byte[] _key = options.Value.Secret is { Length: > 0 } secret
        ? Encoding.UTF8.GetBytes(secret)
        : RandomNumberGenerator.GetBytes(32);

    /// <summary>First 16 hex characters of HMAC-SHA256(secret, roomId).</summary>
    public string Room(string roomId) =>
        Convert.ToHexStringLower(HMACSHA256.HashData(_key, Encoding.UTF8.GetBytes(roomId)))[..16];
}
