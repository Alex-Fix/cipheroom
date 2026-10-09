using System.Runtime.CompilerServices;

namespace Cipheroom.Api.FunctionalTests;

internal static class TestEnvironment
{
    /// <summary>Test hosts keep the usage guard's file out of the repo, one fresh file per test run.</summary>
    [ModuleInitializer]
    internal static void Initialize() =>
        Environment.SetEnvironmentVariable(
            "UsageGuard__DataPath",
            Path.Combine(Path.GetTempPath(), $"cipheroom-usage-{Guid.NewGuid():N}.json"));
}
