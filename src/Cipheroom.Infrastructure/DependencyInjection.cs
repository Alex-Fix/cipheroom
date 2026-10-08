using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Infrastructure.Rooms;
using Cipheroom.Infrastructure.Rtc;
using Cipheroom.Infrastructure.Rtc.Cloudflare;
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
        services.AddTransient<ISfu, CloudflareSfu>();

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

        // Resolved per use so configuration (and typed HttpClient lifetimes) are honoured.
        services.AddTransient<IIceServerProvider>(sp =>
            sp.GetRequiredService<IOptions<TurnOptions>>().Value.Cloudflare.IsConfigured
                ? sp.GetRequiredService<CloudflareIceServerProvider>()
                : new DirectIceServerProvider());

        return services;
    }
}
