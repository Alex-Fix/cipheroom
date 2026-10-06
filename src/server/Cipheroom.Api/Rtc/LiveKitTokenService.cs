using System.Text;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace Cipheroom.Api.Rtc;

/// <summary>Issues LiveKit access tokens (HS256 JWT with a "video" grant).</summary>
public sealed class LiveKitTokenService(IOptions<LiveKitOptions> options, TimeProvider time)
{
    private readonly JsonWebTokenHandler _handler = new() { SetDefaultTimesOnTokenCreation = false };

    public string Create(string roomId, string participantId, string displayName)
    {
        var opts = options.Value;
        var now = time.GetUtcNow().UtcDateTime;
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(opts.ApiSecret));

        return _handler.CreateToken(new SecurityTokenDescriptor
        {
            Issuer = opts.ApiKey,
            NotBefore = now,
            Expires = now.AddMinutes(opts.TokenTtlMinutes),
            SigningCredentials = new SigningCredentials(key, SecurityAlgorithms.HmacSha256),
            Claims = new Dictionary<string, object>
            {
                ["sub"] = participantId,
                ["name"] = displayName,
                ["video"] = new Dictionary<string, object>
                {
                    ["room"] = roomId,
                    ["roomJoin"] = true,
                    ["canPublish"] = true,
                    ["canSubscribe"] = true,
                    // Data channels are outside our E2EE key management; chat goes over SignalR.
                    ["canPublishData"] = false,
                },
            },
        });
    }
}
