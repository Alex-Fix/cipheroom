using System.Net;
using System.Text;
using Cipheroom.Domain.Rooms;
using Cipheroom.Infrastructure.Rtc;

namespace Cipheroom.Infrastructure.IntegrationTests.Rtc;

public sealed class CloudflareIceServerProviderTests
{
    private static readonly TurnOptions Turn = new()
    {
        Cloudflare = new CloudflareTurnOptions { KeyId = "key/id", ApiToken = "secret-token" },
        CredentialTtlSeconds = 3600,
    };

    [Fact]
    public async Task Requests_credentials_with_bearer_token_and_ttl_and_forces_relay()
    {
        var handler = new StubHandler(HttpStatusCode.Created,
            """{"iceServers":[{"urls":["turn:turn.cloudflare.com:3478?transport=udp"],"username":"u","credential":"c"}]}""");
        var provider = Create(handler);

        var config = await provider.GetAsync(ParticipantId.New(), TestContext.Current.CancellationToken);

        Assert.True(config.ForceRelay);
        var server = Assert.Single(config.IceServers);
        Assert.Equal(["turn:turn.cloudflare.com:3478?transport=udp"], server.Urls);
        Assert.Equal(("u", "c"), (server.Username, server.Credential));

        Assert.Equal(HttpMethod.Post, handler.Request!.Method);
        Assert.Equal("https://rtc.test/v1/turn/keys/key%2Fid/credentials/generate-ice-servers", handler.Request.RequestUri!.AbsoluteUri);
        Assert.Equal("Bearer secret-token", handler.Request.Headers.Authorization!.ToString());
        Assert.Equal("""{"ttl":3600}""", handler.Body);
    }

    [Fact]
    public async Task Cloudflare_errors_surface_as_exceptions()
    {
        var provider = Create(new StubHandler(HttpStatusCode.Unauthorized, "{}"));
        await Assert.ThrowsAsync<HttpRequestException>(() => provider.GetAsync(ParticipantId.New(), TestContext.Current.CancellationToken));
    }

    private static CloudflareIceServerProvider Create(StubHandler handler) =>
        new(new HttpClient(handler) { BaseAddress = new Uri("https://rtc.test/v1/turn/keys/") }, Microsoft.Extensions.Options.Options.Create(Turn));

    private sealed class StubHandler(HttpStatusCode status, string json) : HttpMessageHandler
    {
        public HttpRequestMessage? Request { get; private set; }
        public string? Body { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Request = request;
            Body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            return new HttpResponseMessage(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }
    }
}
