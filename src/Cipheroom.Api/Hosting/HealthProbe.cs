namespace Cipheroom.Api.Hosting;

/// <summary>
/// <c>dotnet Cipheroom.Api.dll --health</c>: exits 0 if this container's /healthz answers. Used by the Docker
/// HEALTHCHECK because the chiseled runtime image has no shell or curl.
/// </summary>
public static class HealthProbe
{
    public const string Argument = "--health";

    public static async Task<int> RunAsync()
    {
        var port = Environment.GetEnvironmentVariable("ASPNETCORE_HTTP_PORTS")?.Split(';', ',')[0] ?? "8080";
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
        try
        {
            using var response = await http.GetAsync(new Uri($"http://localhost:{port}/healthz"));
            return response.IsSuccessStatusCode ? 0 : 1;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            return 1;
        }
    }
}
