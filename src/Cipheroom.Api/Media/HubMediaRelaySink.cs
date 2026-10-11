using Cipheroom.Api.Hubs;
using Cipheroom.Application.Common.Interfaces;
using Microsoft.AspNetCore.SignalR;

namespace Cipheroom.Api.Media;

/// <summary>Delivers relayed LiveKit messages to the browser that owns the relay (base64 over the JSON protocol).</summary>
public sealed class HubMediaRelaySink(IHubContext<RoomHub, IRoomClient> hub) : IMediaRelaySink
{
    public Task ReceivedAsync(string connectionId, string relayId, ReadOnlyMemory<byte> message, bool text, CancellationToken cancellationToken) =>
        hub.Clients.Client(connectionId).MediaRelayReceived(relayId, Convert.ToBase64String(message.Span), text);

    public Task ClosedAsync(string connectionId, string relayId, int code) =>
        hub.Clients.Client(connectionId).MediaRelayClosed(relayId, code);
}
