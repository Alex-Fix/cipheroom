using Microsoft.AspNetCore.HttpOverrides;

namespace Cipheroom.Api.Hosting;

public static class ForwardedHeadersSetup
{
    public const string Section = "ForwardedHeaders:KnownNetworks";

    /// <summary>
    /// Trust X-Forwarded-* only from our own proxies. The chain is client → Cloudflare → cloudflared → nginx → api,
    /// so both container hops must be in <c>ForwardedHeaders:KnownNetworks</c> (the compose network) and the whole
    /// chain is walked (no forward limit). Loopback is always trusted.
    /// </summary>
    public static IServiceCollection AddTrustedForwardedHeaders(this IServiceCollection services, IConfiguration configuration)
    {
        var networks = configuration.GetSection(Section).Get<string[]>() ?? [];

        services.Configure<ForwardedHeadersOptions>(o =>
        {
            o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost;
            o.ForwardLimit = null;
            foreach (var network in networks)
                o.KnownIPNetworks.Add(System.Net.IPNetwork.Parse(network));
        });
        return services;
    }
}
