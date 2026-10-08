import {
  E2eeTotals,
  MAX_REPORT_INTERVAL_S,
  StatsSnapshot,
  callStats,
  statsSnapshot,
} from './call-stats';

/** A fake RTCStatsReport from plain stat objects. */
function report(stats: Record<string, unknown>[]) {
  const byId = new Map(stats.map((s) => [s['id'] as string, s]));
  return { get: (id: string) => byId.get(id), forEach: (f: (s: any) => void) => stats.forEach(f) };
}

const pair = (localType: string, rttS: number) => [
  { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
  {
    id: 'P',
    type: 'candidate-pair',
    localCandidateId: 'L',
    remoteCandidateId: 'R',
    currentRoundTripTime: rttS,
  },
  { id: 'L', type: 'local-candidate', candidateType: localType, protocol: 'udp' },
  {
    id: 'R',
    type: 'remote-candidate',
    candidateType: 'host',
    protocol: 'udp',
    address: '198.51.100.1',
  },
];

const inVideo = (id: string, bytes: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'inbound-rtp',
  kind: 'video',
  bytesReceived: bytes,
  packetsReceived: bytes / 1000,
  packetsLost: 0,
  jitter: 0.01,
  ...extra,
});
const outAudio = (bytes: number) => ({
  id: 'out-a',
  type: 'outbound-rtp',
  kind: 'audio',
  bytesSent: bytes,
  packetsSent: bytes / 100,
});

const e2ee = (n: number): E2eeTotals => ({
  framesEncrypted: n * 10,
  framesDecrypted: n * 20,
  framesFailed: 0,
  framesMissingKey: n,
  envelopesDropped: 0,
  securingSeconds: n / 2,
});

describe('call stats', () => {
  it('reports what changed per kind and direction over the interval', () => {
    const prev = statsSnapshot(
      report([...pair('host', 0.03), inVideo('v1', 1_000_000), outAudio(50_000)]),
      0,
    );
    const next = statsSnapshot(
      report([
        ...pair('host', 0.04),
        inVideo('v1', 3_000_000, {
          packetsLost: 12,
          totalFreezesDuration: 0.4,
          frameHeight: 720,
          framesPerSecond: 29.97,
        }),
        outAudio(110_000),
      ]),
      15_000,
    );

    const stats = callStats(prev, next, 'desktop-chrome', { prev: e2ee(1), next: e2ee(3) })!;

    expect(stats).toMatchObject({
      platform: 'desktop-chrome',
      path: 'direct',
      intervalSeconds: 15,
      rttMs: 40,
    });
    expect(stats.videoReceived).toEqual({
      bytes: 2_000_000,
      packets: 2000,
      packetsLost: 12,
      jitterMs: 10,
      freezeSeconds: 0.4,
      height: 720,
      fps: 29.97,
    });
    expect(stats.audioSent).toMatchObject({ bytes: 60_000, packets: 600 });
    expect(stats.audioReceived).toBeNull();
    expect(stats.videoSent).toBeNull();
    expect(stats.e2ee).toEqual({
      framesEncrypted: 20,
      framesDecrypted: 40,
      framesFailed: 0,
      framesMissingKey: 2,
      envelopesDropped: 0,
      securingSeconds: 1,
    });
  });

  it('counts a stream that appeared during the interval from zero, and ignores one that went away', () => {
    const prev = statsSnapshot(report([inVideo('gone', 5_000_000)]), 0);
    const next = statsSnapshot(report([inVideo('new', 400_000)]), 15_000);
    expect(callStats(prev, next, 'other', undefined)!.videoReceived!.bytes).toBe(400_000);
  });

  it('treats a counter that went down as reset (new E2EE worker after a rejoin)', () => {
    const prev = statsSnapshot(report([]), 0);
    const next = statsSnapshot(report([]), 15_000);
    expect(
      callStats(prev, next, 'other', { prev: e2ee(50), next: e2ee(2) })!.e2ee!.framesEncrypted,
    ).toBe(20);
  });

  it('reports relayed connections as relay', () => {
    const snap = statsSnapshot(report(pair('relay', 0.08)), 0);
    expect(snap.path).toBe('relay');
    expect(statsSnapshot(report([]), 0).path).toBe('unknown');
  });

  it('skips implausible intervals (tab suspended, clock jump)', () => {
    const prev: StatsSnapshot = statsSnapshot(report([]), 0);
    expect(callStats(prev, statsSnapshot(report([]), 0), 'other', undefined)).toBeUndefined();
    expect(
      callStats(
        prev,
        statsSnapshot(report([]), (MAX_REPORT_INTERVAL_S + 1) * 1000),
        'other',
        undefined,
      ),
    ).toBeUndefined();
  });

  it('never sends ids, addresses or anything but numbers and fixed labels', () => {
    const prev = statsSnapshot(report([...pair('host', 0.03), inVideo('v1', 1000)]), 0);
    const next = statsSnapshot(
      report([...pair('host', 0.03), inVideo('v1', 2000, { trackIdentifier: 'secret-track' })]),
      15_000,
    );
    const json = JSON.stringify(callStats(prev, next, 'ios-safari', undefined));
    expect(json).not.toContain('198.51.100.1');
    expect(json).not.toContain('v1');
    expect(json).not.toContain('secret-track');
  });
});
