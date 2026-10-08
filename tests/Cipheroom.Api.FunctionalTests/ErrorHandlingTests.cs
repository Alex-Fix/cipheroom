using System.Net;
using Cipheroom.Api.Hubs.Contracts;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Testing;

namespace Cipheroom.Api.FunctionalTests;

public sealed class ErrorHandlingTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private const string SecretDetail = "Cloudflare said: token cf-secret-123 is invalid";

    private readonly WebApplicationFactory<Program> _factory = factory.WithWebHostBuilder(b => b
        .ConfigureTestServices(s => s
            .AddLogging(l => l.AddFakeLogging())
            .AddTransient<IIceServerProvider, FailingIceServerProvider>()));

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Unexpected_server_errors_reach_clients_only_as_a_generic_message()
    {
        await using var connection = await ConnectAsync();
        await connection.InvokeAsync<JoinResult>("JoinRoom", "room-err", "Alice", TestIdentity.Dto, TestIdentity.Codecs, Ct);

        var error = await Assert.ThrowsAsync<HubException>(() => connection.InvokeAsync<RtcConfig>("GetRtcConfig", Ct));

        Assert.EndsWith("HubException: Something went wrong.", error.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("cf-secret", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Rejected_calls_are_not_logged_as_errors()
    {
        await using var connection = await ConnectAsync();
        var collector = _factory.Services.GetFakeLogCollector();
        collector.Clear();

        await Assert.ThrowsAsync<HubException>(() => connection.InvokeAsync<JoinResult>("JoinRoom", "BAD ID", "Alice", TestIdentity.Dto, TestIdentity.Codecs, Ct));

        Assert.DoesNotContain(collector.GetSnapshot(), r => r.Level >= LogLevel.Error);
    }

    [Fact]
    public async Task Rest_errors_are_problem_details()
    {
        using var client = _factory.CreateClient();
        var response = await client.GetAsync(new Uri("/does-not-exist", UriKind.Relative), Ct);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
    }

    private async Task<HubConnection> ConnectAsync()
    {
        var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(_factory.Server.BaseAddress, "hubs/room"), o =>
            {
                o.Transports = HttpTransportType.LongPolling;
                o.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
            })
            .Build();
        await connection.StartAsync(Ct);
        return connection;
    }

    private sealed class FailingIceServerProvider : IIceServerProvider
    {
        public Task<IceConfig> GetAsync(ParticipantId participantId, CancellationToken cancellationToken) =>
            throw new HttpRequestException(SecretDetail);
    }
}
