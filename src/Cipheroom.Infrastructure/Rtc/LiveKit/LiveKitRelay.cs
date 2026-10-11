using System.Collections.Concurrent;
using System.Net.WebSockets;
using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Media;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Cipheroom.Infrastructure.Rtc.LiveKit;

/// <summary>
/// <see cref="IMediaRelay"/> on LiveKit: one WebSocket to the LiveKit server per relay, with an access token created
/// here (the browser's placeholder token is dropped). Messages are copied both ways untouched and never logged — they
/// carry SDP and ICE candidates. Spike: docs/plans/2026-10-11-livekit-media-mode-design.md (Spike results).
/// </summary>
public sealed partial class LiveKitRelay(
    IOptions<LiveKitOptions> options,
    LiveKitTokens tokens,
    IMediaRelaySink sink,
    ILogger<LiveKitRelay> logger) : IMediaRelay, IDisposable
{
    /// <summary>What livekit-client sends that LiveKit needs; anything else (its placeholder token included) is dropped.</summary>
    private static readonly HashSet<string> AllowedQuery =
    [
        "join_request", "reconnect", "reconnect_reason", "sid", "auto_subscribe", "adaptive_stream", "subscriber_allow_pause",
        "disable_ice_lite", "sdk", "version", "protocol", "client_protocol", "os", "os_version", "browser", "browser_version",
        "device_model", "network",
    ];

    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(10);

    /// <summary>LiveKit's own messages are small; anything bigger than this closes the relay.</summary>
    private const int MaxDownstreamBytes = 1024 * 1024;

    private readonly ConcurrentDictionary<(string ConnectionId, string RelayId), Relay> _relays = new();

    public async Task OpenAsync(MediaRelayOwner owner, string relayId, string path, string query, CancellationToken cancellationToken)
    {
        var key = (owner.ConnectionId, relayId);
        if (_relays.Keys.Count(k => k.ConnectionId == owner.ConnectionId) >= MediaRules.MaxRelaysPerConnection)
            throw new DomainException(MediaRules.TooManyRelays);

        var relay = new Relay(owner, relayId);
        if (!_relays.TryAdd(key, relay))
        {
            relay.Dispose();
            throw new DomainException(MediaRules.InvalidRelay);
        }

        try
        {
            using var connect = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, relay.Lifetime.Token);
            connect.CancelAfter(ConnectTimeout);
            await relay.Socket.ConnectAsync(Upstream(owner, path, query), connect.Token);
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException)
        {
            if (_relays.TryRemove(new(key, relay)))
                relay.Dispose();
            LogConnectFailed(logger, e.GetType().Name);
            throw new MediaServerException(e);
        }

        LogOpened(logger, relayId);
        _ = Task.Run(() => PumpAsync(key, relay), CancellationToken.None);
    }

    public async Task SendAsync(string connectionId, string relayId, ReadOnlyMemory<byte> message, bool text, CancellationToken cancellationToken)
    {
        if (!_relays.TryGetValue((connectionId, relayId), out var relay) || relay.Socket.State != WebSocketState.Open)
            return;

        // ClientWebSocket allows one send at a time; the hub may run sends for one connection back to back.
        await relay.SendLock.WaitAsync(cancellationToken);
        try
        {
            await relay.Socket.SendAsync(message, text ? WebSocketMessageType.Text : WebSocketMessageType.Binary, endOfMessage: true, cancellationToken);
        }
        catch (WebSocketException)
        {
            // The pump sees the socket fail and reports the close.
        }
        finally
        {
            relay.SendLock.Release();
        }
    }

    public Task CloseAsync(string connectionId, string relayId)
    {
        if (_relays.TryRemove((connectionId, relayId), out var relay))
            Stop(relay);
        return Task.CompletedTask;
    }

    public Task CloseConnectionAsync(string connectionId)
    {
        foreach (var key in _relays.Keys.Where(k => k.ConnectionId == connectionId).ToList())
        {
            if (_relays.TryRemove(key, out var relay))
                Stop(relay);
        }
        return Task.CompletedTask;
    }

    public async Task CloseRoomAsync(RoomId room)
    {
        foreach (var (key, relay) in _relays.Where(r => r.Value.Owner.RoomId == room).ToList())
        {
            if (_relays.TryRemove(new(key, relay)))
            {
                Stop(relay);
                await sink.ClosedAsync(key.ConnectionId, key.RelayId, (int)WebSocketCloseStatus.NormalClosure);
            }
        }
    }

    public void Dispose()
    {
        foreach (var relay in _relays.Values)
            relay.Dispose();
        _relays.Clear();
    }

    private Uri Upstream(MediaRelayOwner owner, string path, string query)
    {
        var parameters = QueryHelpers.ParseQuery(query)
            .Where(p => AllowedQuery.Contains(p.Key))
            .Select(p => KeyValuePair.Create(p.Key, (string?)p.Value.ToString()))
            .Append(KeyValuePair.Create("access_token", (string?)tokens.Participant(owner.RoomId, owner.ParticipantId)));
        var server = new UriBuilder(options.Value.Url);
        server.Scheme = server.Scheme == Uri.UriSchemeHttps ? Uri.UriSchemeWss : Uri.UriSchemeWs;
        server.Path = path;
        return new Uri(QueryHelpers.AddQueryString(server.Uri.ToString(), parameters));
    }

    private async Task PumpAsync((string ConnectionId, string RelayId) key, Relay relay)
    {
        var buffer = new byte[16 * 1024];
        using var message = new MemoryStream();
        var code = (int)WebSocketCloseStatus.EndpointUnavailable;
        try
        {
            while (relay.Socket.State == WebSocketState.Open)
            {
                var received = await relay.Socket.ReceiveAsync(buffer, relay.Lifetime.Token);
                if (received.MessageType == WebSocketMessageType.Close)
                {
                    code = (int)(relay.Socket.CloseStatus ?? WebSocketCloseStatus.NormalClosure);
                    break;
                }
                message.Write(buffer, 0, received.Count);
                if (message.Length > MaxDownstreamBytes)
                    break;
                if (!received.EndOfMessage)
                    continue;
                await sink.ReceivedAsync(key.ConnectionId, key.RelayId, message.ToArray(), received.MessageType == WebSocketMessageType.Text, relay.Lifetime.Token);
                message.SetLength(0);
            }
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException)
        {
            // Closed by us (CloseAsync) or the connection dropped.
        }

        // Closed by LiveKit or the network (not by the browser): tell it, livekit-client reconnects.
        if (_relays.TryRemove(new(key, relay)))
        {
            Stop(relay);
            LogClosedUpstream(logger, key.RelayId, code);
            await sink.ClosedAsync(key.ConnectionId, key.RelayId, code);
        }
    }

    private static void Stop(Relay relay)
    {
        relay.Lifetime.Cancel();
        relay.Dispose();
    }

    private sealed class Relay(MediaRelayOwner owner, string id) : IDisposable
    {
        public MediaRelayOwner Owner { get; } = owner;

        public string Id { get; } = id;

        public ClientWebSocket Socket { get; } = new();

        public CancellationTokenSource Lifetime { get; } = new();

        public SemaphoreSlim SendLock { get; } = new(1, 1);

        public void Dispose()
        {
            Socket.Abort();
            Socket.Dispose();
            Lifetime.Dispose();
            SendLock.Dispose();
        }
    }

    [LoggerMessage(Level = LogLevel.Debug, Message = "Media relay {RelayId} opened")]
    private static partial void LogOpened(ILogger logger, string relayId);

    [LoggerMessage(Level = LogLevel.Information, Message = "Media relay {RelayId} closed by the media server ({Code})")]
    private static partial void LogClosedUpstream(ILogger logger, string relayId, int code);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Media relay could not reach the media server ({Error})")]
    private static partial void LogConnectFailed(ILogger logger, string error);
}
