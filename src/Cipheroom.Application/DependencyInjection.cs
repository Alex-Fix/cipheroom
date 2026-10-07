using Cipheroom.Application.Common.Telemetry;
using FluentValidation;
using Microsoft.Extensions.DependencyInjection;

namespace Cipheroom.Application;

public static class DependencyInjection
{
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        services.AddValidatorsFromAssembly(typeof(DependencyInjection).Assembly, includeInternalTypes: true);
        // Needs IMeterFactory (registered by the host) and IRoomStore (Infrastructure).
        services.AddSingleton<CipheroomMetrics>();
        return services;
    }
}
