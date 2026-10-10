using Cipheroom.Application.Common.Exceptions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Application.Media;
using FluentValidation;
using Mediator;

namespace Cipheroom.Application.Rtc.Queries.GetRtcConfig;

/// <summary>
/// Media connection details for a participant who has joined a room. Also creates their media server session, in
/// parallel with fetching ICE servers, so the first publish doesn't wait for it (it would otherwise be created then).
/// </summary>
public sealed record GetRtcConfigQuery(string ConnectionId) : IQuery<RtcConfigResult>;

public sealed record RtcConfigResult(IReadOnlyList<IceServer> IceServers, bool ForceRelay);

public sealed class GetRtcConfigQueryValidator : AbstractValidator<GetRtcConfigQuery>
{
    public GetRtcConfigQueryValidator() => RuleFor(q => q.ConnectionId).NotEmpty();
}

public sealed class GetRtcConfigQueryHandler(
    IRoomStore rooms,
    IIceServerProvider iceServers,
    ISfu sfu) : IQueryHandler<GetRtcConfigQuery, RtcConfigResult>
{
    public async ValueTask<RtcConfigResult> Handle(GetRtcConfigQuery query, CancellationToken cancellationToken)
    {
        // Only admitted participants get media access.
        var self = MediaSessions.Member(rooms, query.ConnectionId);

        var session = PrepareSessionAsync(query.ConnectionId, cancellationToken);
        var ice = await iceServers.GetAsync(self.Id, cancellationToken);
        await session;
        return new RtcConfigResult(ice.IceServers, ice.ForceRelay);
    }

    /// <summary>Best effort: if the media server fails now, the first publish creates the session as before.</summary>
    private async Task PrepareSessionAsync(string connectionId, CancellationToken cancellationToken)
    {
        try
        {
            await MediaSessions.EnsureAsync(rooms, sfu, connectionId, cancellationToken);
        }
        catch (MediaServerException)
        {
        }
    }
}
