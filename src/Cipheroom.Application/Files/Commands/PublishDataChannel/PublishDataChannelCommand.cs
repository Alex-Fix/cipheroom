using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Common.Telemetry;
using Cipheroom.Application.Media;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Files.Commands.PublishDataChannel;

/// <summary>
/// Publishes a data channel for one file transfer. The name is the client's random one; the media server name is
/// prefixed with the caller's id, so nobody can publish into someone else's channel.
/// </summary>
public sealed record PublishDataChannelCommand(string ConnectionId, string? Name) : ICommand<DataChannelResult>;

/// <param name="ChannelId">Negotiated id for the browser's <c>createDataChannel</c>.</param>
public sealed record DataChannelResult(int ChannelId);

public sealed class PublishDataChannelCommandValidator : AbstractValidator<PublishDataChannelCommand>
{
    public PublishDataChannelCommandValidator()
    {
        RuleFor(c => c.ConnectionId).NotEmpty();
        RuleFor(c => c.Name).Must(FileRules.IsChannelName).WithMessage(Room.InvalidDataChannel);
    }
}

public sealed class PublishDataChannelCommandHandler(IRoomStore rooms, ISfu sfu, IUsageGuard usage, TimeProvider time, CipheroomMetrics metrics)
    : ICommandHandler<PublishDataChannelCommand, DataChannelResult>
{
    public async ValueTask<DataChannelResult> Handle(PublishDataChannelCommand command, CancellationToken cancellationToken)
    {
        FileRules.EnsureAllowed(usage);
        var name = command.Name!;
        var self = MediaSessions.InRoom(rooms, command.ConnectionId, (room, p) =>
        {
            room.EnsureCanPublishDataChannel(p.Id, name);
            return p;
        });

        var id = await sfu.PublishDataChannelAsync(self.SfuSessionId!, DataChannel.SfuNameFor(self.Id, name), cancellationToken);
        MediaSessions.InRoom(rooms, command.ConnectionId, (room, p) => room.PublishDataChannel(p.Id, name, id, time.GetUtcNow()));
        metrics.DataChannels("published");
        return new DataChannelResult(id);
    }
}
