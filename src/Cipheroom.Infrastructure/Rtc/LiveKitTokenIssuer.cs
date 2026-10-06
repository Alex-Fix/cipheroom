using System.Text;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace Cipheroom.Infrastructure.Rtc;

/// <summary>Issues LiveKit access tokens (HS256 JWT with a "video" grant).</summary>
public sealed class LiveKitTokenIssuer(IOptions<LiveKitOptions> options, TimeProvider time) : ILiveKitTokenIssuer
{
    private readonly JsonWebTokenHandler _handler = new() { SetDefaultTimesOnTokenCreation = false };

    public LiveKitAccess Issue(Participant participant)
    {
        var opts = options.Value;
        var now = time.GetUtcNow().UtcDateTime;
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(opts.ApiSecret));

        var token = _handler.CreateToken(new SecurityTokenDescriptor
        {
            Issuer = opts.ApiKey,
            NotBefore = now,
            Expires = now.AddMinutes(opts.TokenTtlMinutes),
            SigningCredentials = new SigningCredentials(key, SecurityAlgorithms.HmacSha256),
            Claims = new Dictionary<string, object>
            {
                ["sub"] = participant.Id.Value,
                ["name"] = participant.DisplayName.Value,
                ["video"] = new Dictionary<string, object>
                {
                    ["room"] = participant.RoomId.Value,
                    ["roomJoin"] = true,
                    ["canPublish"] = true,
                    ["canSubscribe"] = true,
                    // Data channels are outside our E2EE key management; chat goes over SignalR.
                    ["canPublishData"] = false,
                },
            },
        });

        return new LiveKitAccess(opts.Url, token);
    }
}
