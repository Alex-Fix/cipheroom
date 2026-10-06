using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Rtc.Queries.GetRtcConfig;

/// <summary>Media connection details for a participant who has joined a room.</summary>
public sealed record GetRtcConfigQuery(string ConnectionId) : IQuery<RtcConfigResult>;

public sealed record RtcConfigResult(string LivekitUrl, string Token, IReadOnlyList<IceServer> IceServers, bool ForceRelay);

public sealed class GetRtcConfigQueryValidator : AbstractValidator<GetRtcConfigQuery>
{
    public GetRtcConfigQueryValidator() => RuleFor(q => q.ConnectionId).NotEmpty();
}

public sealed class GetRtcConfigQueryHandler(
    IRoomStore rooms,
    ILiveKitTokenIssuer liveKit,
    IIceServerProvider iceServers) : IQueryHandler<GetRtcConfigQuery, RtcConfigResult>
{
    public async ValueTask<RtcConfigResult> Handle(GetRtcConfigQuery query, CancellationToken cancellationToken)
    {
        // Only admitted participants get media access.
        var self = rooms.FindByConnection(query.ConnectionId) ?? throw new NotFoundException("Join a room first.");

        var ice = await iceServers.GetAsync(self.Id, cancellationToken);
        var access = liveKit.Issue(self);
        return new RtcConfigResult(access.Url, access.Token, ice.IceServers, ice.ForceRelay);
    }
}
