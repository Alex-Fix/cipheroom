using System.Runtime.CompilerServices;

namespace Cipheroom.Api.FunctionalTests;

internal static class TestEnvironment
{
    /// <summary>
    /// Test hosts keep the usage guard's file out of the repo, one fresh file per test run; and never reach the real
    /// Cloudflare SFU: tests that don't replace ISfu get a local address that refuses at once.
    /// </summary>
    [ModuleInitializer]
    internal static void Initialize()
    {
        Environment.SetEnvironmentVariable(
            "UsageGuard__DataPath",
            Path.Combine(Path.GetTempPath(), $"cipheroom-usage-{Guid.NewGuid():N}.json"));
        Environment.SetEnvironmentVariable("Sfu__Cloudflare__ApiBaseUrl", "http://127.0.0.1:9/v1/apps/");
    }
}
