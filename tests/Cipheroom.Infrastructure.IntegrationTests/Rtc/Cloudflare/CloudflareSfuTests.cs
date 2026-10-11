using System.Diagnostics.Metrics;
using System.Net;
using System.Text;
using Cipheroom.Application;
using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Common.Telemetry;
using Cipheroom.Infrastructure.Rtc.Cloudflare;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.Metrics.Testing;

namespace Cipheroom.Infrastructure.IntegrationTests.Rtc.Cloudflare;

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
    public async Task Every_request_is_timed_by_operation_and_outcome()
    {
        var (sfu, provider) = SfuWithServices(new StubHandler(HttpStatusCode.Created, """{"sessionId":"s1"}"""));
        using var durations = new MetricCollector<double>(
            provider.GetRequiredService<IMeterFactory>(), CipheroomMetrics.MeterName, "cipheroom.sfu.request.duration");
        await sfu.CreateSessionAsync(_ct);

        var (failing, failingProvider) = SfuWithServices(new StubHandler(HttpStatusCode.BadRequest, """{"errorCode":"x"}"""));
        using var failures = new MetricCollector<double>(
            failingProvider.GetRequiredService<IMeterFactory>(), CipheroomMetrics.MeterName, "cipheroom.sfu.request.duration");
        await Assert.ThrowsAsync<MediaServerException>(() => failing.CreateSessionAsync(_ct));

        Assert.Equal(("create_session", "ok"), Labels(durations.LastMeasurement!));
        Assert.Equal(("create_session", "failed"), Labels(failures.LastMeasurement!));
    }

    private static (string, string) Labels(CollectedMeasurement<double> m) =>
        ((string)m.Tags["operation"]!, (string)m.Tags["outcome"]!);

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

    [Fact]
    public async Task Data_transport_pulls_server_events_and_returns_the_sfu_offer()
    {
        var handler = new StubHandler(HttpStatusCode.OK,
            """{"requiresImmediateRenegotiation":true,"dataChannel":{"dataChannelName":"server-events","id":0},"sessionDescription":{"type":"offer","sdp":"v=0 data offer"}}""");

        var transport = await Sfu(handler).EstablishDataTransportAsync("s1", _ct);

        Assert.Equal(new SfuDataTransport("v=0 data offer", 0), transport);
        var request = Assert.Single(handler.Requests);
        Assert.Equal((HttpMethod.Post, Base + "sessions/s1/datachannels/establish"), (request.Method, request.Uri));
        Assert.Equal("""{"dataChannel":{"location":"remote","dataChannelName":"server-events"}}""", request.Body);
    }

    [Fact]
    public async Task Publishing_a_data_channel_returns_its_id()
    {
        var handler = new StubHandler(HttpStatusCode.OK, """{"dataChannels":[{"location":"local","dataChannelName":"p-abc","id":3}]}""");

        Assert.Equal(3, await Sfu(handler).PublishDataChannelAsync("s1", "p-abc", _ct));
        var request = Assert.Single(handler.Requests);
        Assert.Equal((HttpMethod.Post, Base + "sessions/s1/datachannels/new"), (request.Method, request.Uri));
        Assert.Equal("""{"dataChannels":[{"location":"local","dataChannelName":"p-abc"}]}""", request.Body);
    }

    [Fact]
    public async Task Subscribing_a_data_channel_names_the_publisher_session()
    {
        var handler = new StubHandler(HttpStatusCode.OK, """{"dataChannels":[{"location":"remote","sessionId":"pub","dataChannelName":"p-abc","id":4}]}""");

        Assert.Equal(4, await Sfu(handler).SubscribeDataChannelAsync("s2", "pub", "p-abc", _ct));
        Assert.Equal("""{"dataChannels":[{"location":"remote","sessionId":"pub","dataChannelName":"p-abc"}]}""", Assert.Single(handler.Requests).Body);
    }

    [Fact]
    public async Task A_data_channel_error_fails_the_call()
    {
        var handler = new StubHandler(HttpStatusCode.OK, """{"dataChannels":[{"dataChannelName":"p-abc","errorCode":"not_found"}]}""");

        var error = await Assert.ThrowsAsync<MediaServerException>(() => Sfu(handler).SubscribeDataChannelAsync("s2", "pub", "p-abc", _ct));
        Assert.Equal("not_found", Assert.IsType<CloudflareSfuException>(error.InnerException).ErrorCode);
    }

    [Fact]
    public async Task Data_channels_are_closed_by_id()
    {
        var handler = new StubHandler(HttpStatusCode.OK, """{"dataChannels":[{"id":3},{"id":4}]}""");

        await Sfu(handler).CloseDataChannelsAsync("s1", [3, 4], _ct);

        var request = Assert.Single(handler.Requests);
        Assert.Equal((HttpMethod.Put, Base + "sessions/s1/datachannels/close"), (request.Method, request.Uri));
        Assert.Equal("""{"dataChannels":[{"id":3},{"id":4}]}""", request.Body);
    }

    [Fact]
    public async Task Cloudflare_s_reason_is_kept_in_the_error_without_sdp_or_addresses()
    {
        var handler = new StubHandler(HttpStatusCode.BadRequest,
            """{"errorCode":"invalid_session_description","errorDescription":"Failed to set remote answer sdp: Called in wrong state: stable\na=candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host\nfrom 2001:db8::1"}""");

        var error = await Assert.ThrowsAsync<MediaServerException>(() => Sfu(handler).RenegotiateAsync("s1", "v=0 answer", _ct));

        var message = Assert.IsType<SfuAnswerRefusedException>(error.InnerException).InnerException!.Message;
        Assert.Equal("Cloudflare SFU request failed: HTTP 400 invalid_session_description (Failed to set remote answer sdp: Called in wrong state: stable from [ip])", message);
    }

    [Fact]
    public async Task A_refused_answer_is_logged_with_offered_and_answered_codecs_only()
    {
        const string offer = "v=0\r\no=- 1 2 IN IP4 203.0.113.9\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=rtpmap:111 opus/48000/2\r\n"
            + "m=video 9 UDP/TLS/RTP/SAVPF 98 99\r\nc=IN IP4 203.0.113.9\r\na=mid:3\r\na=fingerprint:sha-256 AB:CD\r\na=rtpmap:98 VP9/90000\r\na=rtpmap:99 rtx/90000\r\n";
        const string answer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=rtpmap:111 opus/48000/2\r\n"
            + "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:3\r\na=ice-pwd:secretpassword\r\na=rtpmap:96 VP8/90000\r\n";
        var handler = new ScriptedHandler(
            (HttpStatusCode.OK, $$"""{"requiresImmediateRenegotiation":true,"sessionDescription":{"type":"offer","sdp":{{System.Text.Json.JsonSerializer.Serialize(offer)}}},"tracks":[{"mid":"3","trackName":"p-camera"}]}"""),
            (HttpStatusCode.BadRequest, """{"errorCode":"invalid_session_description","errorDescription":"Renegotiation failed: The subscriber's SDP is missing the published track's codec."}"""));
        var (sfu, provider) = SfuWithServices(handler);

        await sfu.SubscribeAsync("s1", [new SfuRemoteTrack("pub", "p-camera", Simulcast: true)], _ct);
        var error = await Assert.ThrowsAsync<MediaServerException>(() => sfu.RenegotiateAsync("s1", answer, _ct));

        var refused = Assert.IsType<SfuAnswerRefusedException>(error.InnerException);
        Assert.Equal("SFU refused the answer. Offered: 0:audio[opus] 3:video[VP9]. Answered: 0:audio[opus] 3:video[VP8].", refused.Message);
        Assert.Contains("missing the published track's codec", refused.InnerException!.Message);
        Assert.DoesNotContain("203.0.113.9", error.ToString());
        Assert.DoesNotContain("secretpassword", error.ToString());
        Assert.DoesNotContain("AB:CD", error.ToString());
        Assert.Equal(0, provider.GetRequiredService<PendingOffers>().Count);
    }

    [Fact]
    public async Task An_accepted_answer_settles_the_pending_offer()
    {
        var handler = new ScriptedHandler(
            (HttpStatusCode.OK, """{"requiresImmediateRenegotiation":true,"sessionDescription":{"type":"offer","sdp":"v=0 sfu offer"},"tracks":[]}"""),
            (HttpStatusCode.OK, "{}"));
        var (sfu, provider) = SfuWithServices(handler);

        await sfu.SubscribeAsync("s1", [new SfuRemoteTrack("pub", "p-camera", Simulcast: true)], _ct);
        Assert.Equal(1, provider.GetRequiredService<PendingOffers>().Count);
        await sfu.RenegotiateAsync("s1", "v=0 answer", _ct);

        Assert.Equal(0, provider.GetRequiredService<PendingOffers>().Count);
    }

    [Theory]
    [InlineData(null, "none")]
    [InlineData("", "none")]
    [InlineData("v=0 no sections", "none")]
    [InlineData("v=0\nm=video 9 X 96\na=mid:1\na=rtpmap:96 VP8/90000\na=rtpmap:97 red/90000\na=rtpmap:98 ulpfec/90000", "1:video[VP8]")]
    [InlineData("v=0\nm=video 9 X 96\na=mid:1 192.168.0.1\na=rtpmap:96 <script>/90000\na=rtpmap:97", "?:video[?]")]
    [InlineData("v=0\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\na=mid:2", "2:application[]")]
    public void Codec_summaries_hold_mids_kinds_and_codec_names_only(string? sdp, string expected) =>
        Assert.Equal(expected, SdpCodecs.Summary(sdp));

    [Fact]
    public void Codec_summaries_are_bounded()
    {
        var sdp = "v=0" + string.Concat(Enumerable.Range(0, 200).Select(i => $"\nm=video 9 X 96\na=mid:{i}\na=rtpmap:96 VP8/90000"));
        var summary = SdpCodecs.Summary(sdp);

        Assert.True(summary.Length <= SdpCodecs.MaxLength + 1);
        Assert.DoesNotContain($"{SdpCodecs.MaxSections}:video", summary);
    }

    [Fact]
    public void Pending_offers_drop_the_oldest_when_full()
    {
        var time = new Microsoft.Extensions.Time.Testing.FakeTimeProvider();
        var offers = new PendingOffers(time);
        for (var i = 0; i < PendingOffers.Capacity; i++)
        {
            offers.Remember($"s{i}", "v=0\nm=audio 9 X 111\na=mid:0\na=rtpmap:111 opus/48000");
            time.Advance(TimeSpan.FromMilliseconds(1));
        }

        offers.Remember("newest", "v=0");

        Assert.Equal(PendingOffers.Capacity, offers.Count);
        Assert.Equal("unknown", offers.Take("s0"));
        Assert.Equal("0:audio[opus]", offers.Take("s1"));
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("  ", null)]
    [InlineData("a=fingerprint:sha-256 AB:CD", null)]
    [InlineData("bad offer, line 'm=video 9 UDP/TLS/RTP/SAVPF 96' rejected", "bad offer, line '[sdp]' rejected")]
    [InlineData("peer 10.0.0.7 unreachable", "peer [ip] unreachable")]
    public void Reasons_are_made_safe_to_log(string? description, string? expected) =>
        Assert.Equal(expected, CloudflareSfuException.SafeReason(description));

    [Fact]
    public void Long_reasons_are_cut() =>
        Assert.Equal(CloudflareSfuException.MaxReasonLength + 1, CloudflareSfuException.SafeReason(new string('x', 500))!.Length);

    private static ISfu Sfu(HttpMessageHandler handler) => SfuWithServices(handler).Sfu;

    private static (ISfu Sfu, ServiceProvider Provider) SfuWithServices(HttpMessageHandler handler)
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
            .AddMetrics()
            .AddApplication()
            .AddInfrastructure()
            .AddSingleton<Microsoft.Extensions.Hosting.IHostEnvironment>(new Usage.UsageGuardTests.TestEnvironment("Production"));
        services.AddHttpClient<CloudflareSfuClient>().ConfigurePrimaryHttpMessageHandler(() => handler);
        var provider = services.BuildServiceProvider(new ServiceProviderOptions { ValidateScopes = true, ValidateOnBuild = true });

        var sfu = provider.GetRequiredService<ISfu>();
        Assert.IsType<CloudflareSfu>(sfu);
        return (sfu, provider);
    }

    /// <summary>Answers each request with the next scripted response.</summary>
    private sealed class ScriptedHandler(params (HttpStatusCode Status, string Body)[] responses) : HttpMessageHandler
    {
        private int _next;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var (status, body) = responses[_next++];
            return Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
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
