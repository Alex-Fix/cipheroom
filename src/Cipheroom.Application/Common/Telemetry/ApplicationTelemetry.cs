using System.Diagnostics;

namespace Cipheroom.Application.Common.Telemetry;

/// <summary>
/// Tracing for the use cases: one span per Mediator request, named after the request type. Spans carry no request
/// values (no names, room ids, SDP or envelopes) — the hub's span holds the pseudonymous call ids.
/// </summary>
public static class ApplicationTelemetry
{
    public const string SourceName = "Cipheroom.Application";

    public static readonly ActivitySource Source = new(SourceName);
}
