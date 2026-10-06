using Cipheroom.Application.Common.Behaviours;
using FluentValidation;
using Microsoft.Extensions.DependencyInjection;

namespace Cipheroom.Application;

public static class DependencyInjection
{
    /// <summary>
    /// Pipeline behaviours, outermost first. Passed to <c>AddMediator</c> in the composition root, where the
    /// Mediator source generator runs.
    /// </summary>
    public static readonly Type[] PipelineBehaviours =
    [
        typeof(UnhandledExceptionBehaviour<,>),
        typeof(LoggingBehaviour<,>),
        typeof(ValidationBehaviour<,>),
    ];

    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        services.AddValidatorsFromAssembly(typeof(DependencyInjection).Assembly, includeInternalTypes: true);
        return services;
    }
}
