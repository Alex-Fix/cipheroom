using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using Cipheroom.Application.Common.Interfaces;
using Cipheroom.Domain.Rooms;
using Cipheroom.Infrastructure.Rtc.Cloudflare;

namespace Cipheroom.Api.Spike;

/// <summary>
/// THROWAWAY connectivity spike for Cloudflare Realtime SFU (docs/plans/2026-10-07-cloudflare-sfu-design.md, step 1).
/// Thin pass-through to <see cref="CloudflareSfuClient"/> plus an in-memory "who publishes what" list, driven by
/// web/public/sfu-spike.html. No room membership checks — mapped only when <c>SfuSpike:Enabled</c> is true, and
/// deleted once the real hub methods exist.
/// </summary>
public static partial class SfuSpikeEndpoints
{
    private static readonly ConcurrentDictionary<string, ConcurrentDictionary<string, Publisher>> Rooms = new();

    public static void MapSfuSpike(this WebApplication app)
    {
        if (!app.Configuration.GetValue<bool>("SfuSpike:Enabled"))
            return;

        var sfu = app.MapGroup("/api/spike/sfu");

        sfu.MapGet("/config", async (IIceServerProvider ice, CancellationToken ct) =>
            Results.Ok(await ice.GetAsync(ParticipantId.New(), ct)));

        sfu.MapPost("/sessions", async (CloudflareSfuClient cf, CancellationToken ct) =>
            await Call(async () => new { (await cf.NewSessionAsync(ct)).SessionId }));

        sfu.MapPost("/sessions/{sessionId}/tracks", async (string sessionId, TracksRequest body, CloudflareSfuClient cf, CancellationToken ct) =>
            IsId(sessionId) ? await Call(() => cf.NewTracksAsync(sessionId, body, ct)) : Results.BadRequest());

        sfu.MapPut("/sessions/{sessionId}/tracks/update", async (string sessionId, TracksRequest body, CloudflareSfuClient cf, CancellationToken ct) =>
            IsId(sessionId) ? await Call(() => cf.UpdateTracksAsync(sessionId, body, ct)) : Results.BadRequest());

        sfu.MapPut("/sessions/{sessionId}/renegotiate", async (string sessionId, RenegotiateRequest body, CloudflareSfuClient cf, CancellationToken ct) =>
            IsId(sessionId) ? await Call(() => cf.RenegotiateAsync(sessionId, body, ct)) : Results.BadRequest());

        sfu.MapGet("/rooms/{room}/publishers", (string room) =>
            IsRoom(room) ? Results.Ok(Publishers(room).Values) : Results.BadRequest());

        sfu.MapPost("/rooms/{room}/publishers", (string room, Publisher body) =>
        {
            if (!IsRoom(room) || !IsId(body.SessionId) || body.TrackNames.Count > 3 || body.Name.Length > 64)
                return Results.BadRequest();
            Publishers(room)[body.SessionId] = body;
            return Results.NoContent();
        });

        // POST so navigator.sendBeacon can call it when the tab closes.
        sfu.MapPost("/rooms/{room}/publishers/{sessionId}/leave", (string room, string sessionId) =>
        {
            Publishers(room).TryRemove(sessionId, out _);
            return Results.NoContent();
        });
    }

    private static ConcurrentDictionary<string, Publisher> Publishers(string room) =>
        Rooms.GetOrAdd(room, _ => new ConcurrentDictionary<string, Publisher>());

    private static async Task<IResult> Call<T>(Func<Task<T>> call)
    {
        try
        {
            return Results.Ok(await call());
        }
        catch (CloudflareSfuException e)
        {
            // Spike only: surface Cloudflare's error code to the test page (no request content in it).
            return Results.Json(new { errorCode = e.ErrorCode ?? "unknown", errorDescription = $"HTTP {e.StatusCode}" }, statusCode: 502);
        }
    }

    private static bool IsId(string value) => IdPattern().IsMatch(value);

    private static bool IsRoom(string value) => RoomPattern().IsMatch(value);

    [GeneratedRegex("^[a-zA-Z0-9]{1,64}$")]
    private static partial Regex IdPattern();

    [GeneratedRegex("^[a-z0-9-]{3,64}$")]
    private static partial Regex RoomPattern();

    public sealed record Publisher(string SessionId, string Name, IReadOnlyList<string> TrackNames);
}
