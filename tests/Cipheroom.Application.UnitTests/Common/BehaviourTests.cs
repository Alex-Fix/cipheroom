using Cipheroom.Application.Admission.Commands.JoinLobby;
using Cipheroom.Application.Common.Behaviours;
using FluentValidation;
using Mediator;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Testing;

namespace Cipheroom.Application.UnitTests.Common;

public sealed class BehaviourTests
{
    private static readonly JoinLobbyCommand Secretive = new("conn", TestIdentity.HostedRoom, TestIdentity.Input, TestIdentity.Codecs, Ticket: new TicketInput(TestIdentity.Ed25519Pub, "Very Private Value"));

    [Fact]
    public async Task Validation_failure_stops_before_the_handler()
    {
        var behaviour = new ValidationBehaviour<JoinLobbyCommand, JoinLobbyResult>(
            [new JoinLobbyCommandValidator()], new FakeLogger<ValidationBehaviour<JoinLobbyCommand, JoinLobbyResult>>());
        var handlerCalled = false;

        var error = await Assert.ThrowsAsync<ValidationException>(async () => await behaviour.Handle(
            new JoinLobbyCommand("conn", "BAD", TestIdentity.Input, TestIdentity.Codecs),
            (_, _) => { handlerCalled = true; return ValueTask.FromResult<JoinLobbyResult>(null!); },
            TestContext.Current.CancellationToken));

        Assert.False(handlerCalled);
        Assert.Equal("Invalid room id.", error.Errors.Single().ErrorMessage);
    }

    [Fact]
    public async Task Logs_contain_the_request_type_but_never_its_values()
    {
        var logger = new FakeLogger<LoggingBehaviour<JoinLobbyCommand, JoinLobbyResult>>();
        logger.ControlLevel(LogLevel.Debug, true);

        await new LoggingBehaviour<JoinLobbyCommand, JoinLobbyResult>(logger).Handle(
            Secretive, (_, _) => ValueTask.FromResult<JoinLobbyResult>(null!), TestContext.Current.CancellationToken);

        var record = Assert.Single(logger.Collector.GetSnapshot());
        Assert.Contains(nameof(JoinLobbyCommand), record.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("Very Private Value", record.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Unexpected_errors_are_logged_without_request_values_and_rethrown()
    {
        var logger = new FakeLogger<UnhandledExceptionBehaviour<JoinLobbyCommand, JoinLobbyResult>>();
        var behaviour = new UnhandledExceptionBehaviour<JoinLobbyCommand, JoinLobbyResult>(logger);

        await Assert.ThrowsAsync<InvalidOperationException>(async () => await behaviour.Handle(
            Secretive, (_, _) => throw new InvalidOperationException("boom"), TestContext.Current.CancellationToken));

        var record = Assert.Single(logger.Collector.GetSnapshot());
        Assert.Equal(LogLevel.Error, record.Level);
        Assert.DoesNotContain("Very Private Value", record.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Expected_outcomes_are_not_logged_as_errors()
    {
        var logger = new FakeLogger<UnhandledExceptionBehaviour<JoinLobbyCommand, JoinLobbyResult>>();
        var behaviour = new UnhandledExceptionBehaviour<JoinLobbyCommand, JoinLobbyResult>(logger);

        await Assert.ThrowsAsync<Domain.Common.DomainException>(async () => await behaviour.Handle(
            Secretive, (_, _) => throw new Domain.Common.DomainException("Already in a room."), TestContext.Current.CancellationToken));

        Assert.Empty(logger.Collector.GetSnapshot());
    }
}
