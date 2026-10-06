using System.Text;
using System.Text.Json;
using Cipheroom.Api.Rtc;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace Cipheroom.Api.Tests;

public sealed class LiveKitTokenServiceTests
{
    private static readonly LiveKitOptions Options = new()
    {
        Url = "ws://localhost:7880",
        ApiKey = "testkey",
        ApiSecret = "test-secret-that-is-at-least-32-bytes-long",
        TokenTtlMinutes = 10,
    };

    [Fact]
    public async Task Token_is_signed_and_carries_identity_and_room_grant()
    {
        var time = new FakeTimeProvider(DateTimeOffset.UtcNow);
        var service = new LiveKitTokenService(Microsoft.Extensions.Options.Options.Create(Options), time);

        var token = service.Create("room-1", "abc123", "Alice");

        var result = await new JsonWebTokenHandler().ValidateTokenAsync(token, new TokenValidationParameters
        {
            ValidIssuer = Options.ApiKey,
            ValidateAudience = false,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Options.ApiSecret)),
        });
        Assert.True(result.IsValid, result.Exception?.Message);

        var jwt = (JsonWebToken)result.SecurityToken;
        Assert.Equal("abc123", jwt.Subject);
        Assert.Equal("Alice", jwt.GetClaim("name").Value);
        Assert.Equal(time.GetUtcNow().AddMinutes(10).ToUnixTimeSeconds(), jwt.GetPayloadValue<long>("exp"));

        var video = JsonDocument.Parse(Base64UrlEncoder.Decode(jwt.EncodedPayload)).RootElement.GetProperty("video");
        Assert.Equal("room-1", video.GetProperty("room").GetString());
        Assert.True(video.GetProperty("roomJoin").GetBoolean());
        Assert.False(video.GetProperty("canPublishData").GetBoolean());
    }
}
