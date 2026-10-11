using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Media;
using Cipheroom.Domain.Rooms;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Files.Commands.OpenDataTransport;

/// <summary>
/// Sets up the data channel transport on the caller's media session, once, before their first file transfer. The SFU
/// answers with an offer the client must answer (Renegotiate) before publishing or subscribing data channels.
/// </summary>
public sealed record OpenDataTransportCommand(string ConnectionId) : ICommand<OpenDataTransportResult>;

/// <param name="ServerEventsChannelId">Negotiated id of the SFU's own channel the transport is built on.</param>
public sealed record OpenDataTransportResult(string OfferSdp, int ServerEventsChannelId);

public sealed class OpenDataTransportCommandValidator : AbstractValidator<OpenDataTransportCommand>
{
    public OpenDataTransportCommandValidator() => RuleFor(c => c.ConnectionId).NotEmpty();
}

public sealed class OpenDataTransportCommandHandler(IRoomStore rooms, ISfu sfu) : ICommandHandler<OpenDataTransportCommand, OpenDataTransportResult>
{
    public async ValueTask<OpenDataTransportResult> Handle(OpenDataTransportCommand command, CancellationToken cancellationToken)
    {
        var self = await MediaSessions.EnsureAsync(rooms, sfu, command.ConnectionId, cancellationToken);
        if (self.HasDataTransport)
            throw new Domain.Common.DomainException(Room.DataTransportAlreadyOpen);

        var transport = await sfu.EstablishDataTransportAsync(self.SfuSessionId!, cancellationToken);
        MediaSessions.InRoom(rooms, command.ConnectionId, (room, p) => room.AttachDataTransport(p.Id));
        return new OpenDataTransportResult(transport.OfferSdp, transport.ServerEventsChannelId);
    }
}
