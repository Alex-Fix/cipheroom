using Cipheroom.Application.Common.Telemetry;
using OpenTelemetry;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace Cipheroom.Api.Telemetry;

/// <summary>
/// OpenTelemetry for the api (docs/plans/2026-10-07-observability-design.md): traces, metrics and logs, exported over
/// OTLP to the collector when <c>OTEL_EXPORTER_OTLP_ENDPOINT</c> is set (compose profile <c>observability</c>), and not
/// exported at all otherwise. Console logging is unchanged either way. Sampling happens in the collector (keeps
/// every error), so the api records every trace.
/// </summary>
public static class TelemetrySetup
{
    public const string ServiceName = "cipheroom-api";

    public static WebApplicationBuilder AddTelemetry(this WebApplicationBuilder builder)
    {
        builder.Services.AddOptions<TelemetryOptions>().BindConfiguration(TelemetryOptions.Section);
        builder.Services.AddSingleton<TelemetryIds>();
        builder.Services.AddSingleton<HubTelemetryFilter>();

        var telemetry = builder.Services.AddOpenTelemetry()
            .ConfigureResource(r => r.AddService(ServiceName, serviceVersion: typeof(TelemetrySetup).Assembly.GetName().Version?.ToString()))
            .WithTracing(t => t
                .AddSource(HubTelemetryFilter.SourceName, ApplicationTelemetry.SourceName)
                // Hub traffic is traced per invocation by HubTelemetryFilter; the long-lived connection request and
                // health probes would only add noise.
                .AddAspNetCoreInstrumentation(o =>
                {
                    o.Filter = http =>
                        !http.Request.Path.StartsWithSegments("/hubs") && !http.Request.Path.StartsWithSegments("/healthz");
                    // SignalR's own per-invocation spans would duplicate ours (and carry the connection id).
                    o.EnableAspNetCoreSignalRSupport = false;
                })
                .AddHttpClientInstrumentation()
                .AddProcessor<PrivacyProcessor>())
            .WithMetrics(m => m
                .AddMeter(CipheroomMetrics.MeterName)
                .AddAspNetCoreInstrumentation()
                .AddHttpClientInstrumentation()
                .AddRuntimeInstrumentation())
            // Readable text in Loki, not just the template. Our messages hold ids, hashes and method names only.
            .WithLogging(configureBuilder: null, configureOptions: o => o.IncludeFormattedMessage = true);

        if (!string.IsNullOrWhiteSpace(builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]))
            telemetry.UseOtlpExporter();

        return builder;
    }
}
