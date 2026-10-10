import {
  ConnectionReport,
  EncryptionHealth,
  HealthContext,
  MAX_HEALTH_INTERVAL_MS,
  POOR_STREAK,
  PoorStreak,
  connectionReport,
  healthSnapshot,
  reportText,
  streamText,
  verdictText,
} from './connection-health';

/** A fake RTCStatsReport from plain stat objects. */
function report(stats: Record<string, unknown>[]) {
  const byId = new Map(stats.map((s) => [s['id'] as string, s]));
  return { get: (id: string) => byId.get(id), forEach: (f: (s: any) => void) => stats.forEach(f) };
}

const pair = (localType = 'host', rttS = 0.04, relayProtocol?: string) => [
  { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
  {
    id: 'P',
    type: 'candidate-pair',
    localCandidateId: 'L',
    remoteCandidateId: 'R',
    currentRoundTripTime: rttS,
  },
  { id: 'L', type: 'local-candidate', candidateType: localType, protocol: 'udp', relayProtocol },
  { id: 'R', type: 'remote-candidate', candidateType: 'host', address: '198.51.100.1' },
];

const codecs = [
  { id: 'C-vp9', type: 'codec', mimeType: 'video/VP9' },
  { id: 'C-opus', type: 'codec', mimeType: 'audio/opus' },
];

/** Camera layer on mid 1. */
const cam = (rid: string, bytes: number, extra: Record<string, unknown> = {}) => ({
  id: `out-${rid}`,
  type: 'outbound-rtp',
  kind: 'video',
  mid: '1',
  rid,
  codecId: 'C-vp9',
  bytesSent: bytes,
  packetsSent: bytes / 1000,
  frameWidth: { f: 1920, h: 960, q: 480 }[rid],
  frameHeight: { f: 1080, h: 540, q: 270 }[rid],
  framesPerSecond: 30,
  qualityLimitationReason: 'none',
  ...extra,
});

const mic = (bytes: number) => ({
  id: 'out-a',
  type: 'outbound-rtp',
  kind: 'audio',
  mid: '0',
  codecId: 'C-opus',
  bytesSent: bytes,
  packetsSent: bytes / 100,
});

const inbound = (packets: number, lost: number) => ({
  id: 'in-v',
  type: 'inbound-rtp',
  kind: 'video',
  bytesReceived: packets * 1000,
  packetsReceived: packets,
  packetsLost: lost,
  jitter: 0.012,
});

const remoteLost = (localId: string, lost: number) => ({
  id: `ri-${localId}`,
  type: 'remote-inbound-rtp',
  localId,
  packetsLost: lost,
});

const encryption: EncryptionHealth = {
  secured: 2,
  participants: 2,
  epoch: 3,
  totals: {
    framesEncrypted: 1000,
    framesDecrypted: 2000,
    framesFailed: 0,
    framesMissingKey: 4,
    envelopesDropped: 1,
    securingSeconds: 1,
  },
  dropped: { 'stale-epoch': 1 },
};

const context = (extra: Partial<HealthContext> = {}): HealthContext => ({
  state: 'connected',
  forceRelay: false,
  sources: new Map([
    ['0', 'microphone'],
    ['1', 'camera'],
  ]),
  enabled: { microphone: true, camera: true, screen: false },
  videoAllowed: true,
  targetHeight: 1080,
  encryption,
  ...extra,
});

/** Two readings 2 s apart. */
function reading(
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
  ctx = context(),
): ConnectionReport {
  const prev = healthSnapshot(report([...codecs, ...before]), 0);
  const next = healthSnapshot(report([...codecs, ...after]), 2000);
  return connectionReport(prev, next, ctx)!;
}

const healthy = (): [Record<string, unknown>[], Record<string, unknown>[]] => [
  [...pair(), mic(0), cam('f', 0), cam('h', 0), cam('q', 0), inbound(0, 0), remoteLost('out-f', 0)],
  [
    ...pair(),
    mic(16_000),
    cam('f', 500_000),
    cam('h', 125_000),
    cam('q', 30_000),
    inbound(1000, 0),
    remoteLost('out-f', 0),
  ],
];

describe('connectionReport', () => {
  it('is good on a direct, clean connection, with rates and what we send', () => {
    const r = reading(...healthy());

    expect(r.verdict).toBe('good');
    expect(r.reasons).toEqual([]);
    expect(r.route).toEqual({
      relay: false,
      protocol: 'udp',
      relayProtocol: undefined,
      remoteAddress: '198.51.100.1',
      rttMs: 40,
    });
    expect(r.network.uploadKbps).toBe(2684); // (16 000 + 655 000) × 8 / 2 s
    expect(r.network.downloadKbps).toBe(4000);
    expect(r.network.downloadLossPercent).toBe(0);
    expect(r.network.jitterMs).toBe(12);
    const [microphone, camera] = r.sending;
    expect(microphone).toEqual(
      expect.objectContaining({ source: 'microphone', status: 'on', codec: 'Opus', kbps: 64 }),
    );
    expect(camera).toEqual(
      expect.objectContaining({
        source: 'camera',
        codec: 'VP9',
        height: 1080,
        fps: 30,
        kbps: 2620,
        layers: ['f', 'h', 'q'],
      }),
    );
    expect(streamText(camera)).toBe('VP9 · 1080p @ 30 fps · 2620 kbps · layers f h q');
  });

  it('is relay through TURN, and names the relay transport', () => {
    const [before, after] = healthy();
    const r = reading(
      [...pair('relay', 0.05, 'tls'), ...before.slice(4)],
      [...pair('relay', 0.05, 'tls'), ...after.slice(4)],
    );

    expect(r.verdict).toBe('relay');
    expect(verdictText(r)).toBe('Connected through a relay (TLS)');
  });

  it('is poor with download loss at the threshold', () => {
    const [before, after] = healthy();
    after[after.length - 2] = inbound(950, 50); // 50 of 1000 = 5%

    const r = reading(before, after);

    expect(r.verdict).toBe('poor');
    expect(r.reasons).toEqual(['5% packet loss receiving']);
  });

  it('is poor with upload loss reported by the SFU', () => {
    const [before, after] = healthy();
    after[after.length - 1] = remoteLost('out-f', 60); // of 815 packets sent

    expect(reading(before, after).reasons).toEqual(['7.4% packet loss sending']);
  });

  it('ignores loss over too few packets', () => {
    const [before, after] = healthy();
    after[after.length - 2] = inbound(10, 5);

    expect(reading(before, after).verdict).toBe('good');
  });

  it('is poor with a slow round trip', () => {
    const [before, after] = healthy();
    const r = reading(
      [...pair('host', 0.3), ...before.slice(4)],
      [...pair('host', 0.3), ...after.slice(4)],
    );

    expect(r.reasons).toEqual(['Slow round trip (300 ms)']);
  });

  it('is poor when the camera is held below the chosen quality by bandwidth', () => {
    const before = [...pair(), cam('f', 1000), cam('h', 0), cam('q', 0)];
    const after = [
      ...pair(),
      cam('f', 1000, { active: true, qualityLimitationReason: 'bandwidth' }), // no longer sending
      cam('h', 200_000, {
        qualityLimitationReason: 'bandwidth',
        frameWidth: 640,
        frameHeight: 360,
      }),
      cam('q', 50_000, { qualityLimitationReason: 'bandwidth' }),
    ];

    const r = reading(before, after);

    expect(r.verdict).toBe('poor');
    expect(r.reasons).toEqual(['Slow upload — sending 360p instead of 1080p']);
    expect(r.sending[1].layers).toEqual(['h', 'q']);
    expect(r.sending[1].limitation).toBe('bandwidth');
  });

  it('is not poor when the camera is limited but already at the chosen quality', () => {
    const [before, after] = healthy();
    after[5] = cam('f', 500_000, { qualityLimitationReason: 'bandwidth' });

    expect(reading(before, after).verdict).toBe('good');
  });

  it('measures a portrait camera by its shorter side', () => {
    const [before, after] = healthy();
    after[5] = cam('f', 500_000, { frameWidth: 1080, frameHeight: 1920 });

    expect(reading(before, after).sending[1].height).toBe(1080);
  });

  it('skips the limitation rule where the browser has no qualityLimitationReason (Firefox)', () => {
    const before = [...pair(), cam('h', 0)];
    const after = [...pair(), cam('h', 200_000, { qualityLimitationReason: undefined })];

    const r = reading(before, after);

    expect(r.verdict).toBe('good');
    expect(r.sending[1].limitation).toBeUndefined();
  });

  it('is unknown while connecting or reconnecting', () => {
    const [before, after] = healthy();
    const r = reading(before, after, context({ state: 'reconnecting' }));

    expect(r.verdict).toBe('unknown');
    expect(verdictText(r)).toBe('Reconnecting…');
  });

  it('is unknown without a selected candidate pair', () => {
    const [before, after] = healthy();
    expect(reading(before.slice(4), after.slice(4)).verdict).toBe('unknown');
  });

  it('shows muted, off and paused devices without numbers', () => {
    const [before, after] = healthy();
    const r = reading(
      before,
      after,
      context({ enabled: { microphone: false, camera: true, screen: true }, videoAllowed: false }),
    );

    expect(r.sending.map((s) => [s.source, s.status])).toEqual([
      ['microphone', 'muted'],
      ['camera', 'paused'],
      ['screen', 'paused'],
    ]);
    expect(streamText(r.sending[1])).toBe('Video paused by usage guard');
    // The missing video isn't a problem.
    expect(r.verdict).toBe('good');
  });

  it('has no rates on the first reading', () => {
    const r = connectionReport(
      undefined,
      healthSnapshot(report([...codecs, ...healthy()[1]]), 0),
      context(),
    )!;

    expect(r.network).toEqual({});
    expect(r.sending[1].kbps).toBeUndefined();
    expect(r.sending[1].layers).toEqual(['f', 'h', 'q']);
  });

  it('counts a counter that went down (new stream after a reconnect) from zero', () => {
    const [before, after] = healthy();
    before[5] = cam('f', 9_000_000);

    expect(reading(before, after).sending[1].kbps).toBe(2620);
  });

  it('has no report after a long gap (throttled tab)', () => {
    const [before, after] = healthy();
    const prev = healthSnapshot(report(before), 0);
    const next = healthSnapshot(report(after), MAX_HEALTH_INTERVAL_MS + 1);

    expect(connectionReport(prev, next, context())).toBeUndefined();
  });
});

describe('PoorStreak', () => {
  it(`shows after ${POOR_STREAK} poor readings and hides after ${POOR_STREAK} others`, () => {
    const streak = new PoorStreak();
    const seen: boolean[] = [];
    for (let i = 0; i < POOR_STREAK; i++) seen.push(streak.update('poor'));
    for (let i = 0; i < POOR_STREAK; i++) seen.push(streak.update('relay'));

    expect(seen).toEqual([false, false, false, false, true, true, true, true, true, false]);
  });

  it('starts over after a good reading in between', () => {
    const streak = new PoorStreak();
    for (let i = 0; i < POOR_STREAK - 1; i++) streak.update('poor');
    streak.update('good');

    expect(streak.update('poor')).toBe(false);
  });

  it('hides at once and resets when the verdict is unknown', () => {
    const streak = new PoorStreak();
    for (let i = 0; i < POOR_STREAK; i++) streak.update('poor');

    expect(streak.update('unknown')).toBe(false);
    expect(streak.update('poor')).toBe(false);
  });
});

describe('reportText', () => {
  it('has the numbers but no addresses, names or ids', () => {
    const [before, after] = healthy();
    const text = reportText(reading(before, after), 'desktop-chrome');

    expect(text).toContain('Status: Good connection');
    expect(text).toContain('Direct to the media server (UDP)');
    expect(text).toContain('Round trip: 40 ms');
    expect(text).toContain(
      'Camera: VP9 · 1080p @ 30 fps · 2620 kbps · layers f h q · limited by —',
    );
    expect(text).toContain('Keys: from 2 of 2 people');
    expect(text).toContain('Dropped envelopes (stale epoch): 1');
    expect(text).not.toContain('198.51.100.1');
    expect(text).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});
