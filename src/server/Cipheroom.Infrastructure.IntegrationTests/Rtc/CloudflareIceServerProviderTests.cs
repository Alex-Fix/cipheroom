using System.Net;
using System.Text;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;
using Cipheroom.Infrastructure.Rtc;
using Cipheroom.Infrastructure.Rtc.Cloudflare;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Cipheroom.Infrastructure.IntegrationTests.Rtc;

/// <summary>Goes through the real AddInfrastructure() registration; only the network handler is stubbed.</summary>
public sealed class CloudflareIceServerProviderTests
{
    [Fact]
    public async Task Typed_client_sends_bearer_token_and_ttl_and_provider_forces_relay()
    {
        var handler = new StubHandler(HttpStatusCode.Created,
            """{"iceServers":[{"urls":["turn:turn.cloudflare.com:3478?transport=udp"],"username":"u","credential":"c"}]}""");
        using var services = BuildServices(handler);

        var provider = services.GetRequiredService<IIceServerProvider>();
        var config = await provider.GetAsync(ParticipantId.New(), TestContext.Current.CancellationToken);

        Assert.IsType<CloudflareIceServerProvider>(provider);
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
        using var services = BuildServices(new StubHandler(HttpStatusCode.Unauthorized, "{}"));
        var client = services.GetRequiredService<CloudflareTurnClient>();

        await Assert.ThrowsAsync<HttpRequestException>(() =>
            client.GenerateIceServersAsync(TimeSpan.FromHours(1), TestContext.Current.CancellationToken));
    }

    [Fact]
    public void Without_turn_credentials_the_direct_provider_is_used()
    {
        using var services = BuildServices(new StubHandler(HttpStatusCode.OK, "{}"), keyId: "", token: "");
        Assert.IsType<DirectIceServerProvider>(services.GetRequiredService<IIceServerProvider>());
    }

    private static ServiceProvider BuildServices(StubHandler handler, string keyId = "key/id", string token = "secret-token")
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LiveKit:Url"] = "ws://livekit.test",
            ["LiveKit:ApiKey"] = "testkey",
            ["LiveKit:ApiSecret"] = "test-secret-that-is-at-least-32-bytes-long",
            ["Turn:Cloudflare:ApiBaseUrl"] = "https://rtc.test/v1/turn/keys/",
            ["Turn:Cloudflare:KeyId"] = keyId,
            ["Turn:Cloudflare:ApiToken"] = token,
            ["Turn:CredentialTtlSeconds"] = "3600",
        }).Build();

        var services = new ServiceCollection()
            .AddSingleton<IConfiguration>(configuration)
            .AddLogging()
            .AddInfrastructure();
        services.AddHttpClient<CloudflareTurnClient>().ConfigurePrimaryHttpMessageHandler(() => handler);
        return services.BuildServiceProvider(new ServiceProviderOptions { ValidateScopes = true, ValidateOnBuild = true });
    }

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
