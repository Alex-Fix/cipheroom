using System.Diagnostics;
using OpenTelemetry;

namespace Cipheroom.Api.Telemetry;

/// <summary>
/// Removes what default instrumentation records but telemetry must never hold: client addresses, user agents, full
/// URLs (Cloudflare request paths carry app and session ids), connection ids. Runs before any exporter.
/// </summary>
public sealed class PrivacyProcessor : BaseProcessor<Activity>
{
    public static readonly IReadOnlySet<string> RemovedTags = new HashSet<string>(StringComparer.Ordinal)
    {
        "client.address",
        "client.port",
        "network.peer.address",
        "network.peer.port",
        "server.socket.address",
        "url.full",
        "url.query",
        "user_agent.original",
        "signalr.connection_id",
        "signalr.user",
        "enduser.id",
    };

    public override void OnEnd(Activity data)
    {
        foreach (var tag in data.TagObjects.Select(t => t.Key).ToArray())
        {
            if (RemovedTags.Contains(tag) || tag.StartsWith("http.request.header.", StringComparison.Ordinal)
                || tag.StartsWith("http.response.header.", StringComparison.Ordinal))
            {
                data.SetTag(tag, null);
            }
        }
    }
}
