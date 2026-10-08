using Cipheroom.Application.Common.Behaviours;
using Cipheroom.Application.Rooms.Commands.JoinRoom;
using FluentValidation;
using Mediator;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Testing;

namespace Cipheroom.Application.UnitTests.Common;

public sealed class BehaviourTests
{
    private static readonly JoinRoomCommand Secretive = new("conn", "room-1", "Very Private Name", TestIdentity.Input, TestIdentity.Codecs);

    [Fact]
    public async Task Validation_failure_stops_before_the_handler()
    {
        var behaviour = new ValidationBehaviour<JoinRoomCommand, JoinRoomResult>(
            [new JoinRoomCommandValidator()], new FakeLogger<ValidationBehaviour<JoinRoomCommand, JoinRoomResult>>());
        var handlerCalled = false;

        var error = await Assert.ThrowsAsync<ValidationException>(async () => await behaviour.Handle(
            new JoinRoomCommand("conn", "BAD", "Alice", TestIdentity.Input, TestIdentity.Codecs),
            (_, _) => { handlerCalled = true; return ValueTask.FromResult<JoinRoomResult>(null!); },
            TestContext.Current.CancellationToken));

        Assert.False(handlerCalled);
        Assert.Equal("Invalid room id.", error.Errors.Single().ErrorMessage);
    }

    [Fact]
    public async Task Logs_contain_the_request_type_but_never_its_values()
    {
        var logger = new FakeLogger<LoggingBehaviour<JoinRoomCommand, JoinRoomResult>>();
        logger.ControlLevel(LogLevel.Debug, true);

        await new LoggingBehaviour<JoinRoomCommand, JoinRoomResult>(logger).Handle(
            Secretive, (_, _) => ValueTask.FromResult<JoinRoomResult>(null!), TestContext.Current.CancellationToken);

        var record = Assert.Single(logger.Collector.GetSnapshot());
        Assert.Contains(nameof(JoinRoomCommand), record.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("Very Private Name", record.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Unexpected_errors_are_logged_without_request_values_and_rethrown()
    {
        var logger = new FakeLogger<UnhandledExceptionBehaviour<JoinRoomCommand, JoinRoomResult>>();
        var behaviour = new UnhandledExceptionBehaviour<JoinRoomCommand, JoinRoomResult>(logger);

        await Assert.ThrowsAsync<InvalidOperationException>(async () => await behaviour.Handle(
            Secretive, (_, _) => throw new InvalidOperationException("boom"), TestContext.Current.CancellationToken));

        var record = Assert.Single(logger.Collector.GetSnapshot());
        Assert.Equal(LogLevel.Error, record.Level);
        Assert.DoesNotContain("Very Private Name", record.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Expected_outcomes_are_not_logged_as_errors()
    {
        var logger = new FakeLogger<UnhandledExceptionBehaviour<JoinRoomCommand, JoinRoomResult>>();
        var behaviour = new UnhandledExceptionBehaviour<JoinRoomCommand, JoinRoomResult>(logger);

        await Assert.ThrowsAsync<Domain.Common.DomainException>(async () => await behaviour.Handle(
            Secretive, (_, _) => throw new Domain.Common.DomainException("Already in a room."), TestContext.Current.CancellationToken));

        Assert.Empty(logger.Collector.GetSnapshot());
    }
}
