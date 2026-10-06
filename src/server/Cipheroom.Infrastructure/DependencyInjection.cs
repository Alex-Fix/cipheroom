using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Infrastructure.Rooms;
using Cipheroom.Infrastructure.Rtc;
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
        services.AddHttpClient<CloudflareIceServerProvider>(c => c.BaseAddress = new("https://rtc.live.cloudflare.com/v1/turn/keys/"))
            .AddStandardResilienceHandler();

        // Resolved per use so configuration (and typed HttpClient lifetimes) are honoured.
        services.AddTransient<IIceServerProvider>(sp =>
            sp.GetRequiredService<IOptions<TurnOptions>>().Value.Cloudflare.IsConfigured
                ? sp.GetRequiredService<CloudflareIceServerProvider>()
                : new DirectIceServerProvider());

        return services;
    }
}
