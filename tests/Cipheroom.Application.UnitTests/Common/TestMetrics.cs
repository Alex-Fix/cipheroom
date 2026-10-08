using System.Diagnostics.Metrics;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Common.Telemetry;
using Microsoft.Extensions.DependencyInjection;

namespace Cipheroom.Application.UnitTests.Common;

/// <summary>A real <see cref="CipheroomMetrics"/> on its own meter factory (read it with MetricCollector).</summary>
internal static class TestMetrics
{
    public static (CipheroomMetrics Metrics, IMeterFactory Factory) Create(IRoomStore rooms, TimeProvider? time = null)
    {
        var factory = new ServiceCollection().AddMetrics().BuildServiceProvider().GetRequiredService<IMeterFactory>();
        return (new CipheroomMetrics(factory, rooms, time ?? TimeProvider.System), factory);
    }
}
