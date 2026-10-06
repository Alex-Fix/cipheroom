using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Infrastructure.Rooms;
using Cipheroom.Infrastructure.Rtc;
using Cipheroom.Infrastructure.Rtc.Cloudflare;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Cipheroom.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(this IServiceCollection services)
    {
        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<IRoomStore, InMemoryRoomStore>();

        services.AddOptions<LiveKitOptions>().BindConfiguration(LiveKitOptions.Section).ValidateDataAnnotations().ValidateOnStart();
        services.AddOptions<TurnOptions>().BindConfiguration(TurnOptions.Section).ValidateDataAnnotations().ValidateOnStart();

        services.AddSingleton<ILiveKitTokenIssuer, LiveKitTokenIssuer>();
        // Typed client: configured once from options; pooled handlers, DNS refresh and resilience from the factory.
        services.AddHttpClient<CloudflareTurnClient>((sp, http) =>
            {
                var cloudflare = sp.GetRequiredService<IOptions<TurnOptions>>().Value.Cloudflare;
                http.BaseAddress = new Uri(cloudflare.ApiBaseUrl);
                http.DefaultRequestHeaders.Authorization = new("Bearer", cloudflare.ApiToken);
            })
            .AddStandardResilienceHandler();
        services.AddTransient<CloudflareIceServerProvider>();

        // Resolved per use so configuration (and typed HttpClient lifetimes) are honoured.
        services.AddTransient<IIceServerProvider>(sp =>
            sp.GetRequiredService<IOptions<TurnOptions>>().Value.Cloudflare.IsConfigured
                ? sp.GetRequiredService<CloudflareIceServerProvider>()
                : new DirectIceServerProvider());

        return services;
    }
}
