using System.Collections.Concurrent;

namespace Cipheroom.Infrastructure.Rtc;

/// <summary>
/// The codec summary (<see cref="SdpCodecs"/>) of the last SFU offer each session still has to answer, so a refused
/// answer can be logged as "offered … / answered …". Memory only, never the SDP itself; bounded — the oldest entry is
/// dropped when full (an offer whose answer never came).
/// </summary>
public sealed class PendingOffers(TimeProvider time)
{
    public const int Capacity = 1000;

    private readonly ConcurrentDictionary<string, (string Summary, long At)> _offers = new(StringComparer.Ordinal);

    public void Remember(string sessionId, string offerSdp)
    {
        if (_offers.Count >= Capacity && !_offers.ContainsKey(sessionId)
            && _offers.MinBy(e => e.Value.At) is { Key: { } oldest })
        {
            _offers.TryRemove(oldest, out _);
        }

        _offers[sessionId] = (SdpCodecs.Summary(offerSdp), time.GetTimestamp());
    }

    /// <summary>The pending offer's summary, removing it (answered or refused, it's settled).</summary>
    public string Take(string sessionId) => _offers.TryRemove(sessionId, out var offer) ? offer.Summary : "unknown";

    public int Count => _offers.Count;
}

/// <summary>Cloudflare refused our answer to its offer. Carries codec summaries only (see <see cref="SdpCodecs"/>).</summary>
public sealed class SfuAnswerRefusedException(string offered, string answered, Exception innerException)
    : Exception($"SFU refused the answer. Offered: {offered}. Answered: {answered}.", innerException);
