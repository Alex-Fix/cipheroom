using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Infrastructure.Crypto;
using Cipheroom.Infrastructure.Rooms;
using Cipheroom.Infrastructure.Rtc;
using Cipheroom.Infrastructure.Rtc.Cloudflare;
using Cipheroom.Infrastructure.Rtc.LiveKit;
using Cipheroom.Infrastructure.Usage;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http.Resilience;
using Microsoft.Extensions.Options;

namespace Cipheroom.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(this IServiceCollection services)
    {
        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<IRoomStore, InMemoryRoomStore>();
        services.AddSingleton<ISignatureVerifier, Ed25519SignatureVerifier>();

        services.AddOptions<TurnOptions>().BindConfiguration(TurnOptions.Section).ValidateDataAnnotations().ValidateOnStart();

        // Typed client: configured once from options; pooled handlers, DNS refresh and resilience from the factory.
        services.AddHttpClient<CloudflareTurnClient>((sp, http) =>
            {
                var cloudflare = sp.GetRequiredService<IOptions<TurnOptions>>().Value.Cloudflare;
                http.BaseAddress = new Uri(cloudflare.ApiBaseUrl);
                http.DefaultRequestHeaders.Authorization = new("Bearer", cloudflare.ApiToken);
            })
            .AddStandardResilienceHandler();
        services.AddTransient<CloudflareIceServerProvider>();

        services.AddOptions<SfuOptions>().BindConfiguration(SfuOptions.Section).ValidateDataAnnotations().ValidateOnStart();
        services.AddHttpClient<CloudflareSfuClient>((sp, http) =>
            {
                var cloudflare = sp.GetRequiredService<IOptions<SfuOptions>>().Value.Cloudflare;
                http.BaseAddress = new Uri(new Uri(cloudflare.ApiBaseUrl), $"{Uri.EscapeDataString(cloudflare.AppId)}/");
                http.DefaultRequestHeaders.Authorization = new("Bearer", cloudflare.AppSecret);
            })
            // Track and session mutations aren't idempotent: a retried POST/PUT could add tracks twice.
            .AddStandardResilienceHandler(o => o.Retry.DisableForUnsafeHttpMethods());
        services.AddSingleton<PendingOffers>();
        services.AddTransient<CloudflareSfu>();
        services.AddTransient<CloudflareMediaRoom>();

        // LiveKit mode (docs/plans/2026-10-11-livekit-media-mode-design.md): signaling relayed over SignalR, server API
        // for removals and ended calls. The provider is one per deployment (Media:Provider).
        services.AddOptions<LiveKitOptions>().BindConfiguration(LiveKitOptions.Section).ValidateDataAnnotations().ValidateOnStart();
        services.AddOptions<MediaOptions>().BindConfiguration(MediaOptions.Section).ValidateOnStart();
        services.AddSingleton<IValidateOptions<MediaOptions>, MediaOptionsValidator>();
        services.AddSingleton<LiveKitTokens>();
        services.AddHttpClient<LiveKitRoomServiceClient>((sp, http) =>
                http.BaseAddress = new Uri(sp.GetRequiredService<IOptions<LiveKitOptions>>().Value.Url.TrimEnd('/') + "/"))
            // Removing a participant or deleting a room twice is harmless; LiveKit is on the same host.
            .AddStandardResilienceHandler();
        services.AddTransient<LiveKitMediaRoom>();

        services.AddTransient<ISfu>(sp => IsLiveKit(sp) ? new UnavailableSfu() : sp.GetRequiredService<CloudflareSfu>());
        services.AddTransient<IMediaRoom>(sp => IsLiveKit(sp) ? sp.GetRequiredService<LiveKitMediaRoom>() : sp.GetRequiredService<CloudflareMediaRoom>());
        // Created only in LiveKit mode: its sink (the hub) is provided by the api.
        services.AddSingleton<IMediaRelay>(sp => IsLiveKit(sp) ? ActivatorUtilities.CreateInstance<LiveKitRelay>(sp) : new NoMediaRelay());

        // Free-tier usage from Cloudflare's GraphQL Analytics (read-only token), polled in the background.
        services.AddOptions<RealtimeUsageOptions>().BindConfiguration(RealtimeUsageOptions.Section).ValidateDataAnnotations().ValidateOnStart();
        services.AddHttpClient<CloudflareAnalyticsClient>((sp, http) =>
            {
                var cloudflare = sp.GetRequiredService<IOptions<RealtimeUsageOptions>>().Value.Cloudflare;
                http.BaseAddress = new Uri(cloudflare.ApiBaseUrl);
                http.DefaultRequestHeaders.Authorization = new("Bearer", cloudflare.ApiToken);
            })
            .AddStandardResilienceHandler();
        services.AddTransient<IRealtimeUsage, CloudflareRealtimeUsage>();
        services.AddHostedService<RealtimeUsagePoller>();

        // The usage guard: one instance is the guard, the ledger browser reports feed, and its background loop.
        services.AddOptions<UsageGuardOptions>().BindConfiguration(UsageGuardOptions.Section).ValidateDataAnnotations().ValidateOnStart();
        services.AddSingleton<UsageGuard>();
        services.AddSingleton<IUsageGuard>(sp => sp.GetRequiredService<UsageGuard>());
        services.AddSingleton<IUsageLedger>(sp => sp.GetRequiredService<UsageGuard>());
        services.AddHostedService(sp => sp.GetRequiredService<UsageGuard>());

        // Resolved per use so configuration (and typed HttpClient lifetimes) are honoured.
        services.AddTransient<IIceServerProvider>(sp =>
            sp.GetRequiredService<IOptions<TurnOptions>>().Value.Cloudflare.IsConfigured
                ? sp.GetRequiredService<CloudflareIceServerProvider>()
                : new DirectIceServerProvider());

        return services;
    }

    private static bool IsLiveKit(IServiceProvider sp) =>
        sp.GetRequiredService<IOptions<MediaOptions>>().Value.Provider == MediaProvider.LiveKit;
}
