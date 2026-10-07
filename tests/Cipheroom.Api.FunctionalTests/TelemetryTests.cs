using System.Diagnostics;
using System.Net;
using System.Text;
using Cipheroom.Api.Hubs.Contracts;
using Cipheroom.Api.Telemetry;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Testing;
using Microsoft.Extensions.Options;
using OpenTelemetry;
using OpenTelemetry.Trace;

namespace Cipheroom.Api.FunctionalTests;

/// <summary>
/// Runs alone: ActivitySource listeners are process-wide, so spans from other tests' hosts would show up here.
/// </summary>
[CollectionDefinition(nameof(TelemetryTests), DisableParallelization = true)]
public sealed class TelemetryTestsRunAlone;

/// <summary>
/// What the api's telemetry records (docs/plans/2026-10-07-observability-design.md): one trace per hub call with its
/// Mediator command and Cloudflare requests as children, pseudonymous ids, and nothing that must never be recorded.
/// </summary>
[Collection(nameof(TelemetryTests))]
public sealed class TelemetryTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private const string Secret = "test-telemetry-secret";
    private const string Room = "telemetry-plain-room";
    private const string TurnToken = "turn-api-token-123";

    private readonly List<Activity> _spans = [];
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Each_hub_call_is_its_own_trace_with_pseudonymous_ids()
    {
        var host = Host();
        await using var connection = await ConnectAsync(host);

        var join = await connection.InvokeAsync<JoinResult>("JoinRoom", Room, "Alice", TestIdentity.Dto, Ct);
        await connection.InvokeAsync<RtcConfig>("GetRtcConfig", Ct);

        var joinSpan = Span("RoomHub/JoinRoom");
        var rtcSpan = Span("RoomHub/GetRtcConfig");
        Assert.Null(joinSpan.ParentId);
        Assert.NotEqual(joinSpan.TraceId, rtcSpan.TraceId);
        Assert.Equal(ExpectedRoomHash(), joinSpan.GetTagItem(HubTelemetryFilter.Tags.Room));
        Assert.Equal(join.SelfId, joinSpan.GetTagItem(HubTelemetryFilter.Tags.Participant));
        Assert.Equal("ok", joinSpan.GetTagItem(HubTelemetryFilter.Tags.Outcome));

        var command = Span("JoinRoomCommand");
        Assert.Equal(joinSpan.TraceId, command.TraceId);
        Assert.Equal(joinSpan.SpanId, command.ParentSpanId);
    }

    [Fact]
    public async Task Cloudflare_requests_are_child_spans_without_urls_or_credentials()
    {
        using var turn = new FakeTurnServer();
        var host = Host(turn);
        await using var connection = await ConnectAsync(host);
        await connection.InvokeAsync<JoinResult>("JoinRoom", Room, "Alice", TestIdentity.Dto, Ct);

        await connection.InvokeAsync<RtcConfig>("GetRtcConfig", Ct);

        var hubSpan = Span("RoomHub/GetRtcConfig");
        var http = Assert.Single(_spans, s => s.Kind == ActivityKind.Client && s.TraceId == hubSpan.TraceId);
        Assert.Equal("POST", http.GetTagItem("http.request.method"));
        Assert.Equal(201, http.GetTagItem("http.response.status_code"));
        Assert.Null(http.GetTagItem("url.full")); // carries the TURN key id
    }

    [Fact]
    public async Task Rejected_calls_record_the_constant_message_only()
    {
        var host = Host();
        await using var connection = await ConnectAsync(host);

        await Assert.ThrowsAsync<HubException>(() =>
            connection.InvokeAsync<JoinResult>("JoinRoom", "BAD ROOM <script>", "Alice", TestIdentity.Dto, Ct));

        var span = Span("RoomHub/JoinRoom");
        Assert.Equal("rejected", span.GetTagItem(HubTelemetryFilter.Tags.Outcome));
        Assert.Equal("Invalid room id.", span.GetTagItem(HubTelemetryFilter.Tags.Reason));
        Assert.Null(span.GetTagItem(HubTelemetryFilter.Tags.Room));
    }

    [Fact]
    public async Task Nothing_identifying_or_secret_reaches_traces_or_logs()
    {
        using var turn = new FakeTurnServer();
        var host = Host(turn);
        await using var connection = await ConnectAsync(host);
        await connection.InvokeAsync<JoinResult>("JoinRoom", Room, "Very Private Name", TestIdentity.Dto, Ct);
        await connection.InvokeAsync<RtcConfig>("GetRtcConfig", Ct);
        await connection.InvokeAsync("LeaveRoom", Ct);

        string[] forbidden = [Room, "Very Private Name", TestIdentity.Ed25519Pub, TurnToken, "turn-key-1", connection.ConnectionId!];
        Assert.Contains(_spans, s => s.Kind == ActivityKind.Client);
        foreach (var span in _spans)
        {
            Assert.DoesNotContain(span.TagObjects, t => PrivacyProcessor.RemovedTags.Contains(t.Key));
            foreach (var (key, value) in span.TagObjects)
                Assert.DoesNotContain(forbidden, f => value?.ToString()?.Contains(f, StringComparison.Ordinal) == true);
        }

        var logs = host.Services.GetRequiredService<FakeLogCollector>().GetSnapshot();
        Assert.Contains(logs, r => r.Message.Contains(ExpectedRoomHash(), StringComparison.Ordinal));
        Assert.DoesNotContain(logs, r => forbidden.Any(f => r.Message.Contains(f, StringComparison.Ordinal)));
    }

    [Fact]
    public void Room_hashes_are_keyed_stable_and_short()
    {
        var ids = new TelemetryIds(Options.Create(new TelemetryOptions { Secret = Secret }));
        var other = new TelemetryIds(Options.Create(new TelemetryOptions { Secret = "another-secret" }));

        Assert.Equal(ids.Room(Room), ids.Room(Room));
        Assert.Matches("^[0-9a-f]{16}$", ids.Room(Room));
        Assert.NotEqual(ids.Room(Room), ids.Room("other-room"));
        Assert.NotEqual(ids.Room(Room), other.Room(Room));
    }

    [Fact]
    public void Without_a_secret_hashes_use_a_random_key()
    {
        var a = new TelemetryIds(Options.Create(new TelemetryOptions()));
        var b = new TelemetryIds(Options.Create(new TelemetryOptions()));
        Assert.NotEqual(a.Room(Room), b.Room(Room));
    }

    private Activity Span(string name) => Assert.Single(_spans, s => s.DisplayName == name);

    private static string ExpectedRoomHash() =>
        new TelemetryIds(Options.Create(new TelemetryOptions { Secret = Secret })).Room(Room);

    /// <param name="turn">Cloudflare TURN stand-in; none = TURN unconfigured (no HTTP calls).</param>
    private WebApplicationFactory<Program> Host(FakeTurnServer? turn = null) =>
        factory.WithWebHostBuilder(b => b
            .UseSetting("Telemetry:Secret", Secret)
            .UseSetting("Turn:Cloudflare:ApiBaseUrl", turn?.BaseUrl ?? "https://rtc.live.cloudflare.com/v1/turn/keys/")
            .UseSetting("Turn:Cloudflare:KeyId", turn is null ? "" : "turn-key-1")
            .UseSetting("Turn:Cloudflare:ApiToken", turn is null ? "" : TurnToken)
            .ConfigureTestServices(s =>
            {
                s.AddLogging(l => l.AddFakeLogging());
                s.ConfigureOpenTelemetryTracerProvider(t => t.AddInMemoryExporter(_spans));
            }));

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

    /// <summary>
    /// Cloudflare TURN stand-in on a real local socket: the api's HttpClient keeps its full handler chain, including the
    /// diagnostics handler that creates client spans (a stubbed primary handler would bypass it).
    /// </summary>
    private sealed class FakeTurnServer : IDisposable
    {
        private readonly HttpListener _listener = new();

        public FakeTurnServer()
        {
            var port = FreePort();
            BaseUrl = $"http://127.0.0.1:{port}/v1/turn/keys/";
            _listener.Prefixes.Add($"http://127.0.0.1:{port}/");
            _listener.Start();
            _ = ServeAsync();
        }

        public string BaseUrl { get; }

        public void Dispose() => _listener.Close();

        private async Task ServeAsync()
        {
            while (_listener.IsListening)
            {
                HttpListenerContext context;
                try
                {
                    context = await _listener.GetContextAsync();
                }
                catch (Exception e) when (e is HttpListenerException or ObjectDisposedException)
                {
                    return;
                }
                var body = Encoding.UTF8.GetBytes(
                    """{"iceServers":[{"urls":["turn:turn.cloudflare.com:3478?transport=udp"],"username":"u","credential":"c"}]}""");
                context.Response.StatusCode = 201;
                context.Response.ContentType = "application/json";
                await context.Response.OutputStream.WriteAsync(body);
                context.Response.Close();
            }
        }

        private static int FreePort()
        {
            using var socket = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
            socket.Start();
            return ((IPEndPoint)socket.LocalEndpoint).Port;
        }
    }
}
