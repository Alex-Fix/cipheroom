using System.Threading.Channels;
using Cipheroom.Api.Hubs.Contracts;
using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Testing;

namespace Cipheroom.Api.FunctionalTests;

/// <summary>
/// Media signaling as clients see it (docs/signaling-protocol.md), against a fake media server. Pins the room
/// boundary, broadcasts and exact error messages.
/// </summary>
public sealed class MediaHubTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private const string Offer = "v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\n";
    private static readonly string[] Screen = ["screen"];

    private readonly WebApplicationFactory<Program> _factory = Configure(factory, new FakeSfu());

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Published_tracks_are_announced_to_others_and_listed_for_later_joiners()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        var published = Channel.CreateUnbounded<(string Id, IReadOnlyList<TrackDto> Tracks)>();
        bob.On<string, IReadOnlyList<TrackDto>>("TracksPublished", (id, tracks) => published.Writer.TryWrite((id, tracks)));
        var aliceJoin = await alice.InvokeAsync<JoinResult>("JoinRoom", "media-1", "Alice", TestIdentity.Dto, TestIdentity.Codecs, Ct);
        await bob.InvokeAsync<JoinResult>("JoinRoom", "media-1", "Bob", TestIdentity.Dto, TestIdentity.Codecs, Ct);

        var answer = await alice.InvokeAsync<AnswerDto>("PublishTracks", Offer,
            new[] { new PublishTrackDto("0", "microphone"), new PublishTrackDto("1", "camera") }, Ct);

        Assert.Equal(FakeSfu.Answer, answer.AnswerSdp);
        var announced = await published.Reader.ReadAsync(Timeout());
        Assert.Equal(aliceJoin.SelfId, announced.Id);
        Assert.Equal([new TrackDto("microphone", "audio", false), new TrackDto("camera", "video", false)], announced.Tracks);

        await using var carol = await ConnectAsync();
        var carolJoin = await carol.InvokeAsync<JoinResult>("JoinRoom", "media-1", "Carol", TestIdentity.Dto, TestIdentity.Codecs, Ct);
        Assert.Equal(announced.Tracks, carolJoin.Participants.Single(p => p.Id == aliceJoin.SelfId).Tracks);
    }

    [Fact]
    public async Task Subscribing_returns_the_sfu_offer_and_receiving_mids()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        var aliceJoin = await alice.InvokeAsync<JoinResult>("JoinRoom", "media-2", "Alice", TestIdentity.Dto, TestIdentity.Codecs, Ct);
        await bob.InvokeAsync<JoinResult>("JoinRoom", "media-2", "Bob", TestIdentity.Dto, TestIdentity.Codecs, Ct);
        await alice.InvokeAsync<AnswerDto>("PublishTracks", Offer, new[] { new PublishTrackDto("1", "camera") }, Ct);

        var result = await bob.InvokeAsync<SubscribeResult>("SubscribeTracks", new[] { new TrackRefDto(aliceJoin.SelfId, "camera") }, Ct);

        Assert.Equal(FakeSfu.SubscribeOffer, result.OfferSdp);
        var track = Assert.Single(result.Tracks);
        Assert.Equal((aliceJoin.SelfId, "camera"), (track.ParticipantId, track.Source));
        await bob.InvokeAsync("Renegotiate", "v=0 answer", Ct);
        await bob.InvokeAsync("SelectVideoLayer", track.Mid, "q", Ct);
    }

    [Fact]
    public async Task Tracks_in_another_room_are_unknown()
    {
        await using var alice = await ConnectAsync();
        await using var mallory = await ConnectAsync();
        var aliceJoin = await alice.InvokeAsync<JoinResult>("JoinRoom", "media-3", "Alice", TestIdentity.Dto, TestIdentity.Codecs, Ct);
        await alice.InvokeAsync<AnswerDto>("PublishTracks", Offer, new[] { new PublishTrackDto("1", "camera") }, Ct);
        await mallory.InvokeAsync<JoinResult>("JoinRoom", "media-elsewhere", "Mallory", TestIdentity.Dto, TestIdentity.Codecs, Ct);

        await AssertHubErrorAsync("Unknown track.", () =>
            mallory.InvokeAsync<SubscribeResult>("SubscribeTracks", new[] { new TrackRefDto(aliceJoin.SelfId, "camera") }, Ct));
    }

    [Fact]
    public async Task Mute_and_unpublish_are_announced_to_others()
    {
        await using var alice = await ConnectAsync();
        await using var bob = await ConnectAsync();
        var muted = Channel.CreateUnbounded<(string, string, bool)>();
        var unpublished = Channel.CreateUnbounded<(string, IReadOnlyList<string>)>();
        bob.On<string, string, bool>("TrackMuted", (id, source, m) => muted.Writer.TryWrite((id, source, m)));
        bob.On<string, IReadOnlyList<string>>("TracksUnpublished", (id, sources) => unpublished.Writer.TryWrite((id, sources)));
        var aliceJoin = await alice.InvokeAsync<JoinResult>("JoinRoom", "media-4", "Alice", TestIdentity.Dto, TestIdentity.Codecs, Ct);
        await bob.InvokeAsync<JoinResult>("JoinRoom", "media-4", "Bob", TestIdentity.Dto, TestIdentity.Codecs, Ct);
        await alice.InvokeAsync<AnswerDto>("PublishTracks", Offer,
            new[] { new PublishTrackDto("0", "microphone"), new PublishTrackDto("2", "screen") }, Ct);

        await alice.InvokeAsync("SetTrackMuted", "microphone", true, Ct);
        await alice.InvokeAsync("UnpublishTracks", Screen, Ct);

        Assert.Equal((aliceJoin.SelfId, "microphone", true), await muted.Reader.ReadAsync(Timeout()));
        var (id, sources) = await unpublished.Reader.ReadAsync(Timeout());
        Assert.Equal(aliceJoin.SelfId, id);
        Assert.Equal(["screen"], sources);
    }

    [Fact]
    public async Task Media_calls_are_validated_with_constant_messages()
    {
        await using var connection = await ConnectAsync();
        await AssertHubErrorAsync("Join a room first.", () =>
            connection.InvokeAsync<AnswerDto>("PublishTracks", Offer, new[] { new PublishTrackDto("0", "camera") }, Ct));

        await connection.InvokeAsync<JoinResult>("JoinRoom", "media-5", "Eve", TestIdentity.Dto, TestIdentity.Codecs, Ct);
        const string hostile = "<script>alert(1)</script>";
        await AssertHubErrorAsync("Invalid session description.", () =>
            connection.InvokeAsync<AnswerDto>("PublishTracks", hostile, new[] { new PublishTrackDto("0", "camera") }, Ct));
        await AssertHubErrorAsync("Invalid track.", () =>
            connection.InvokeAsync<AnswerDto>("PublishTracks", Offer, new[] { new PublishTrackDto(hostile, hostile) }, Ct));
        await AssertHubErrorAsync("Invalid layer.", () => connection.InvokeAsync("SelectVideoLayer", "1", "x", Ct));
        await AssertHubErrorAsync("No media session.", () => connection.InvokeAsync("Renegotiate", Offer, Ct));
        await AssertHubErrorAsync("Unknown track.", () => connection.InvokeAsync("SetTrackMuted", "camera", true, Ct));

        await connection.InvokeAsync<AnswerDto>("PublishTracks", Offer, new[] { new PublishTrackDto("0", "camera") }, Ct);
        await AssertHubErrorAsync("Track already published.", () =>
            connection.InvokeAsync<AnswerDto>("PublishTracks", Offer, new[] { new PublishTrackDto("1", "camera") }, Ct));
    }

    [Fact]
    public async Task Media_server_failures_reach_clients_as_a_constant_message_and_sdp_is_never_logged()
    {
        var failing = Configure(factory, new FakeSfu { Fail = true });
        await using var connection = await ConnectAsync(failing);
        await connection.InvokeAsync<JoinResult>("JoinRoom", "media-6", "Alice", TestIdentity.Dto, TestIdentity.Codecs, Ct);
        var collector = failing.Services.GetFakeLogCollector();
        collector.Clear();

        await AssertHubErrorAsync("Media server unavailable.", () =>
            connection.InvokeAsync<AnswerDto>("PublishTracks", Offer, new[] { new PublishTrackDto("0", "camera") }, Ct));

        Assert.DoesNotContain(collector.GetSnapshot(), r => r.Message.Contains("4611731400430051336", StringComparison.Ordinal)
            || (r.Exception?.ToString().Contains("4611731400430051336", StringComparison.Ordinal) ?? false));
    }

    private static WebApplicationFactory<Program> Configure(WebApplicationFactory<Program> factory, FakeSfu sfu) =>
        factory.WithWebHostBuilder(b => b
            .UseSetting("Turn:Cloudflare:KeyId", "")
            .UseSetting("Turn:Cloudflare:ApiToken", "")
            // Generous limits: these tests make many calls on one connection.
            .UseSetting("RateLimiting:Hub:TokenLimit", "1000")
            .UseSetting("RateLimiting:Hub:TokensPerSecond", "1000")
            .ConfigureTestServices(s => s
                .AddLogging(l => l.AddFakeLogging())
                .AddSingleton<ISfu>(sfu)));

    private static async Task AssertHubErrorAsync(string expectedMessage, Func<Task> call)
    {
        var error = await Assert.ThrowsAsync<HubException>(call);
        Assert.EndsWith($"HubException: {expectedMessage}", error.Message, StringComparison.Ordinal);
    }

    private Task<HubConnection> ConnectAsync() => ConnectAsync(_factory);

    private static async Task<HubConnection> ConnectAsync(WebApplicationFactory<Program> host)
    {
        var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(host.Server.BaseAddress, "hubs/room"), o =>
            {
                o.Transports = HttpTransportType.LongPolling;
                o.HttpMessageHandlerFactory = _ => host.Server.CreateHandler();
            })
            .Build();
        await connection.StartAsync(Ct);
        return connection;
    }

    private static CancellationToken Timeout() =>
        CancellationTokenSource.CreateLinkedTokenSource(Ct, new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token).Token;

    /// <summary>Media server stand-in: sessions and mids are counters; <see cref="Fail"/> makes every call fail.</summary>
    private sealed class FakeSfu : ISfu
    {
        public const string Answer = "v=0 fake answer";
        public const string SubscribeOffer = "v=0 fake offer";

        private int _next;

        public bool Fail { get; init; }

        public Task<string> CreateSessionAsync(CancellationToken cancellationToken) => Result($"sess-{Interlocked.Increment(ref _next)}");

        public Task<string> PublishAsync(string sessionId, string offerSdp, IReadOnlyList<SfuLocalTrack> tracks, CancellationToken cancellationToken) =>
            Result(Answer);

        public Task<SfuSubscribeResult> SubscribeAsync(string sessionId, IReadOnlyList<SfuRemoteTrack> tracks, CancellationToken cancellationToken) =>
            Result(new SfuSubscribeResult(SubscribeOffer,
                [.. tracks.Select(t => new SfuPulledTrack(t.PublisherSessionId, t.TrackName, $"{Interlocked.Increment(ref _next)}"))]));

        public Task RenegotiateAsync(string sessionId, string answerSdp, CancellationToken cancellationToken) => Result(0);

        public Task<string> RestartIceAsync(string sessionId, string offerSdp, CancellationToken cancellationToken) => Result(Answer);

        public Task CloseTracksAsync(string sessionId, IReadOnlyList<string> mids, CancellationToken cancellationToken) => Result(0);

        public Task SelectLayerAsync(string sessionId, string mid, SfuRemoteTrack track, string rid, CancellationToken cancellationToken) => Result(0);

        private Task<T> Result<T>(T value) =>
            Fail ? Task.FromException<T>(new MediaServerException(new HttpRequestException("HTTP 503"))) : Task.FromResult(value);
    }
}
