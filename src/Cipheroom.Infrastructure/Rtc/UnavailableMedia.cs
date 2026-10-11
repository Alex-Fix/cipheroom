using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Media;
using Cipheroom.Domain.Common;
using Cipheroom.Domain.Rooms;

namespace Cipheroom.Infrastructure.Rtc;

/// <summary>LiveKit mode: Cloudflare's negotiation methods answer "Not available in this media mode."</summary>
public sealed class UnavailableSfu : ISfu
{
    public Task<string> CreateSessionAsync(CancellationToken cancellationToken) => throw Unavailable();
    public Task<string> PublishAsync(string sessionId, string offerSdp, IReadOnlyList<SfuLocalTrack> tracks, CancellationToken cancellationToken) => throw Unavailable();
    public Task<SfuSubscribeResult> SubscribeAsync(string sessionId, IReadOnlyList<SfuRemoteTrack> tracks, CancellationToken cancellationToken) => throw Unavailable();
    public Task RenegotiateAsync(string sessionId, string answerSdp, CancellationToken cancellationToken) => throw Unavailable();
    public Task<string> RestartIceAsync(string sessionId, string offerSdp, CancellationToken cancellationToken) => throw Unavailable();
    public Task CloseTracksAsync(string sessionId, IReadOnlyList<string> mids, CancellationToken cancellationToken) => throw Unavailable();
    public Task SelectLayerAsync(string sessionId, string mid, SfuRemoteTrack track, string rid, CancellationToken cancellationToken) => throw Unavailable();
    public Task<SfuDataTransport> EstablishDataTransportAsync(string sessionId, CancellationToken cancellationToken) => throw Unavailable();
    public Task<int> PublishDataChannelAsync(string sessionId, string name, CancellationToken cancellationToken) => throw Unavailable();
    public Task<int> SubscribeDataChannelAsync(string sessionId, string publisherSessionId, string name, CancellationToken cancellationToken) => throw Unavailable();
    public Task CloseDataChannelsAsync(string sessionId, IReadOnlyList<int> ids, CancellationToken cancellationToken) => throw Unavailable();

    private static DomainException Unavailable() => new(MediaRules.NotInThisMode);
}

/// <summary>Cloudflare mode: there is no signaling relay; leaving and closing are no-ops.</summary>
public sealed class NoMediaRelay : IMediaRelay
{
    public Task OpenAsync(MediaRelayOwner owner, string relayId, string path, string query, CancellationToken cancellationToken) =>
        throw new DomainException(MediaRules.NotInThisMode);

    public Task SendAsync(string connectionId, string relayId, ReadOnlyMemory<byte> message, bool text, CancellationToken cancellationToken) => Task.CompletedTask;
    public Task CloseAsync(string connectionId, string relayId) => Task.CompletedTask;
    public Task CloseConnectionAsync(string connectionId) => Task.CompletedTask;
    public Task CloseRoomAsync(RoomId room) => Task.CompletedTask;
}
