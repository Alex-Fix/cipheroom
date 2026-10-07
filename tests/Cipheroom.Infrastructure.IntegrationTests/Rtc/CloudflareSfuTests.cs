using System.Net;
using System.Text;
using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Infrastructure.Rtc;
using Cipheroom.Infrastructure.Rtc.Cloudflare;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Cipheroom.Infrastructure.IntegrationTests.Rtc;

/// <summary>Goes through the real AddInfrastructure() registration; only the network handler is stubbed.</summary>
public sealed class CloudflareSfuTests
{
    private const string Base = "https://rtc.test/v1/apps/app%2Fid/";
    private readonly CancellationToken _ct = TestContext.Current.CancellationToken;

    [Fact]
    public async Task Create_session_posts_to_sessions_new_with_the_app_secret()
    {
        var handler = new StubHandler(HttpStatusCode.Created, """{"sessionId":"s1"}""");
        var sfu = Sfu(handler);

        Assert.Equal("s1", await sfu.CreateSessionAsync(_ct));
        var request = Assert.Single(handler.Requests);
        Assert.Equal((HttpMethod.Post, Base + "sessions/new"), (request.Method, request.Uri));
        Assert.Equal("Bearer app-secret", request.Authorization);
    }

    [Fact]
    public async Task Publish_sends_the_offer_with_local_tracks_and_returns_the_answer()
    {
        var handler = new StubHandler(HttpStatusCode.OK,
            """{"sessionDescription":{"type":"answer","sdp":"v=0 answer"},"tracks":[{"mid":"0","trackName":"p-camera"}]}""");

        var answer = await Sfu(handler).PublishAsync("s1", "v=0 offer", [new SfuLocalTrack("0", "p-camera")], _ct);

        Assert.Equal("v=0 answer", answer);
        var request = Assert.Single(handler.Requests);
        Assert.Equal((HttpMethod.Post, Base + "sessions/s1/tracks/new"), (request.Method, request.Uri));
        Assert.Equal(
            """{"tracks":[{"location":"local","mid":"0","trackName":"p-camera"}],"sessionDescription":{"type":"offer","sdp":"v=0 offer"}}""",
            request.Body);
    }

    [Fact]
    public async Task Subscribe_pulls_remote_tracks_with_simulcast_for_video_and_maps_mids_by_track_name()
    {
        var handler = new StubHandler(HttpStatusCode.OK,
            """
            {"requiresImmediateRenegotiation":true,"sessionDescription":{"type":"offer","sdp":"v=0 sfu offer"},
             "tracks":[{"mid":"5","trackName":"p-camera","sessionId":"pub"},{"mid":"4","trackName":"p-microphone","sessionId":"pub"}]}
            """);

        var result = await Sfu(handler).SubscribeAsync("s1",
            [new SfuRemoteTrack("pub", "p-microphone", Simulcast: false), new SfuRemoteTrack("pub", "p-camera", Simulcast: true)], _ct);

        Assert.Equal("v=0 sfu offer", result.OfferSdp);
        Assert.Equal([new SfuPulledTrack("pub", "p-camera", "5"), new SfuPulledTrack("pub", "p-microphone", "4")], result.Tracks);
        Assert.Equal(
            """{"tracks":[{"location":"remote","sessionId":"pub","trackName":"p-microphone"},""" +
            """{"location":"remote","sessionId":"pub","trackName":"p-camera","simulcast":{"preferredRid":"f","priorityOrdering":"asciibetical","ridNotAvailable":"asciibetical"}}]}""",
            Assert.Single(handler.Requests).Body);
    }

    [Fact]
    public async Task Subscribe_leaves_out_tracks_the_sfu_could_not_add_but_keeps_its_offer()
    {
        var handler = new StubHandler(HttpStatusCode.OK,
            """
            {"requiresImmediateRenegotiation":true,"sessionDescription":{"type":"offer","sdp":"v=0 sfu offer"},
             "tracks":[{"mid":"5","trackName":"p-camera"},{"trackName":"gone-camera","errorCode":"empty_track_error"}]}
            """);

        var result = await Sfu(handler).SubscribeAsync("s1",
            [new SfuRemoteTrack("pub", "p-camera", true), new SfuRemoteTrack("old", "gone-camera", true)], _ct);

        Assert.Equal("v=0 sfu offer", result.OfferSdp);
        Assert.Equal([new SfuPulledTrack("pub", "p-camera", "5")], result.Tracks);
    }

    [Fact]
    public async Task Ice_restart_renegotiates_with_an_offer_and_returns_the_answer()
    {
        var handler = new StubHandler(HttpStatusCode.OK, """{"sessionDescription":{"type":"answer","sdp":"v=0 a"}}""");

        Assert.Equal("v=0 a", await Sfu(handler).RestartIceAsync("s1", "v=0 o", _ct));
        var request = Assert.Single(handler.Requests);
        Assert.Equal((HttpMethod.Put, Base + "sessions/s1/renegotiate"), (request.Method, request.Uri));
        Assert.Equal("""{"sessionDescription":{"type":"offer","sdp":"v=0 o"}}""", request.Body);
    }

    [Fact]
    public async Task Close_is_forced_by_mid()
    {
        var handler = new StubHandler(HttpStatusCode.OK, """{"tracks":[{"mid":"3","errorCode":"close_track_error"}]}""");

        await Sfu(handler).CloseTracksAsync("s1", ["3"], _ct);

        var request = Assert.Single(handler.Requests);
        Assert.Equal((HttpMethod.Put, Base + "sessions/s1/tracks/close"), (request.Method, request.Uri));
        Assert.Equal("""{"tracks":[{"mid":"3"}],"force":true}""", request.Body);
    }

    [Fact]
    public async Task Layer_selection_updates_the_receiving_track()
    {
        var handler = new StubHandler(HttpStatusCode.OK, """{"tracks":[{"mid":"5"}]}""");

        await Sfu(handler).SelectLayerAsync("s1", "5", new SfuRemoteTrack("pub", "p-camera", true), "q", _ct);

        var request = Assert.Single(handler.Requests);
        Assert.Equal((HttpMethod.Put, Base + "sessions/s1/tracks/update"), (request.Method, request.Uri));
        Assert.Equal(
            """{"tracks":[{"location":"remote","mid":"5","sessionId":"pub","trackName":"p-camera","simulcast":{"preferredRid":"q","priorityOrdering":"asciibetical","ridNotAvailable":"asciibetical"}}]}""",
            request.Body);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, "Unauthorized", "text/plain")]
    [InlineData(HttpStatusCode.OK, """{"errorCode":"invalid_request"}""", "application/json")]
    [InlineData(HttpStatusCode.OK, """{"tracks":[{"mid":"0","errorCode":"track_error"}]}""", "application/json")]
    public async Task Failures_become_media_server_exceptions(HttpStatusCode status, string body, string contentType)
    {
        var sfu = Sfu(new StubHandler(status, body, contentType));

        var ex = await Assert.ThrowsAsync<MediaServerException>(() => sfu.PublishAsync("s1", "v=0", [new SfuLocalTrack("0", "t")], _ct));
        Assert.Equal("Media server unavailable.", ex.Message);
    }

    [Fact]
    public async Task Mutations_are_not_retried()
    {
        var handler = new StubHandler(HttpStatusCode.ServiceUnavailable, "{}");

        await Assert.ThrowsAsync<MediaServerException>(() => Sfu(handler).PublishAsync("s1", "v=0", [new SfuLocalTrack("0", "t")], _ct));

        Assert.Single(handler.Requests);
    }

    private static ISfu Sfu(StubHandler handler)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Sfu:Cloudflare:ApiBaseUrl"] = "https://rtc.test/v1/apps/",
            ["Sfu:Cloudflare:AppId"] = "app/id",
            ["Sfu:Cloudflare:AppSecret"] = "app-secret",
        }).Build();

        var services = new ServiceCollection()
            .AddSingleton<IConfiguration>(configuration)
            .AddLogging()
            .AddInfrastructure();
        services.AddHttpClient<CloudflareSfuClient>().ConfigurePrimaryHttpMessageHandler(() => handler);
        var provider = services.BuildServiceProvider(new ServiceProviderOptions { ValidateScopes = true, ValidateOnBuild = true });

        var sfu = provider.GetRequiredService<ISfu>();
        Assert.IsType<CloudflareSfu>(sfu);
        return sfu;
    }

    private sealed record Recorded(HttpMethod Method, string Uri, string? Authorization, string? Body);

    private sealed class StubHandler(HttpStatusCode status, string body, string contentType = "application/json") : HttpMessageHandler
    {
        public List<Recorded> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(new Recorded(
                request.Method,
                request.RequestUri!.AbsoluteUri,
                request.Headers.Authorization?.ToString(),
                request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken)));
            return new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, contentType) };
        }
    }
}
