using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Media;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Rtc.Queries.GetRtcConfig;

/// <summary>Media connection details for a participant who has joined a room.</summary>
public sealed record GetRtcConfigQuery(string ConnectionId) : IQuery<RtcConfigResult>;

public sealed record RtcConfigResult(IReadOnlyList<IceServer> IceServers, bool ForceRelay);

public sealed class GetRtcConfigQueryValidator : AbstractValidator<GetRtcConfigQuery>
{
    public GetRtcConfigQueryValidator() => RuleFor(q => q.ConnectionId).NotEmpty();
}

public sealed class GetRtcConfigQueryHandler(
    IRoomStore rooms,
    IIceServerProvider iceServers) : IQueryHandler<GetRtcConfigQuery, RtcConfigResult>
{
    public async ValueTask<RtcConfigResult> Handle(GetRtcConfigQuery query, CancellationToken cancellationToken)
    {
        // Only admitted participants get media access.
        var self = MediaSessions.Member(rooms, query.ConnectionId);

        var ice = await iceServers.GetAsync(self.Id, cancellationToken);
        return new RtcConfigResult(ice.IceServers, ice.ForceRelay);
    }
}
