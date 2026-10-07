import {
  CallPlatform,
  CallStatsDto,
  E2eeStatsDto,
  StreamStatsDto,
} from '../signaling/signaling.types';
import { StatsLike, selectedIcePath } from './ice-path';

/**
 * Call-quality reports (ReportCallStats): what changed between two `getStats()` snapshots, per kind and direction.
 * Cumulative counters are diffed per stream id, so streams appearing or disappearing (someone joins, a track is
 * replaced) never produce negative or inflated numbers. Numbers only — no ids, names or addresses leave the browser.
 */

type Kind = 'audio' | 'video';
type Direction = 'sent' | 'received';

interface StreamCounters {
  kind: Kind;
  direction: Direction;
  bytes: number;
  packets: number;
  packetsLost: number;
  freezeSeconds?: number;
}

interface StreamGauges {
  kind: Kind;
  direction: Direction;
  jitterMs?: number;
  height?: number;
  fps?: number;
}

/** One `getStats()` reading, reduced to what reports need. */
export interface StatsSnapshot {
  /** ms (performance or Date clock — only differences matter). */
  at: number;
  counters: Map<string, StreamCounters>;
  gauges: StreamGauges[];
  rttMs?: number;
  path: CallStatsDto['path'];
}

/** E2EE counters since the call's encryption started (CryptoService.telemetry). */
export type E2eeTotals = E2eeStatsDto;

/** Reports are skipped when the interval is implausible (tab suspended, clock jump). */
export const MAX_REPORT_INTERVAL_S = 120;

export function statsSnapshot(report: StatsLike, at: number): StatsSnapshot {
  const counters = new Map<string, StreamCounters>();
  const gauges: StreamGauges[] = [];
  report.forEach((s) => {
    const kind: Kind | undefined = s.kind === 'audio' || s.kind === 'video' ? s.kind : undefined;
    if (!kind || (s.type !== 'inbound-rtp' && s.type !== 'outbound-rtp')) return;
    const direction: Direction = s.type === 'inbound-rtp' ? 'received' : 'sent';
    counters.set(s.id, {
      kind,
      direction,
      bytes: num(direction === 'received' ? s.bytesReceived : s.bytesSent),
      packets: num(direction === 'received' ? s.packetsReceived : s.packetsSent),
      packetsLost: direction === 'received' ? num(s.packetsLost) : 0,
      freezeSeconds:
        typeof s.totalFreezesDuration === 'number' ? s.totalFreezesDuration : undefined,
    });
    gauges.push({
      kind,
      direction,
      jitterMs: typeof s.jitter === 'number' ? s.jitter * 1000 : undefined,
      height: typeof s.frameHeight === 'number' ? s.frameHeight : undefined,
      fps: typeof s.framesPerSecond === 'number' ? s.framesPerSecond : undefined,
    });
  });
  const ice = selectedIcePath(report);
  return {
    at,
    counters,
    gauges,
    rttMs: ice?.rttMs,
    path: !ice ? 'unknown' : ice.localType === 'relay' ? 'relay' : 'direct',
  };
}

/** The report for the interval between two snapshots, or `undefined` when the interval is implausible. */
export function callStats(
  prev: StatsSnapshot,
  next: StatsSnapshot,
  platform: CallPlatform,
  e2ee: { prev: E2eeTotals; next: E2eeTotals } | undefined,
): CallStatsDto | undefined {
  const intervalSeconds = (next.at - prev.at) / 1000;
  if (!(intervalSeconds > 0 && intervalSeconds <= MAX_REPORT_INTERVAL_S)) return undefined;

  const stream = (kind: Kind, direction: Direction): StreamStatsDto | null => {
    let found = false;
    const sum = { bytes: 0, packets: 0, packetsLost: 0, freeze: 0, hasFreeze: false };
    next.counters.forEach((n, id) => {
      if (n.kind !== kind || n.direction !== direction) return;
      found = true;
      const p = prev.counters.get(id);
      sum.bytes += delta(n.bytes, p?.bytes);
      sum.packets += delta(n.packets, p?.packets);
      sum.packetsLost += delta(n.packetsLost, p?.packetsLost);
      if (n.freezeSeconds !== undefined) {
        sum.hasFreeze = true;
        sum.freeze += delta(n.freezeSeconds, p?.freezeSeconds);
      }
    });
    if (!found) return null;
    const gauges = next.gauges.filter((g) => g.kind === kind && g.direction === direction);
    const jitter = values(gauges.map((g) => g.jitterMs));
    const heights = values(gauges.map((g) => g.height));
    const fps = values(gauges.map((g) => g.fps));
    return {
      bytes: sum.bytes,
      packets: sum.packets,
      packetsLost: sum.packetsLost,
      jitterMs: jitter.length ? round(average(jitter)) : null,
      freezeSeconds: sum.hasFreeze ? round(Math.min(sum.freeze, intervalSeconds)) : null,
      height: heights.length ? Math.max(...heights) : null,
      fps: fps.length ? round(Math.max(...fps)) : null,
    };
  };

  return {
    platform,
    path: next.path,
    intervalSeconds: round(intervalSeconds),
    rttMs: next.rttMs ?? null,
    audioSent: stream('audio', 'sent'),
    audioReceived: stream('audio', 'received'),
    videoSent: stream('video', 'sent'),
    videoReceived: stream('video', 'received'),
    e2ee: e2ee ? e2eeDelta(e2ee.prev, e2ee.next) : null,
  };
}

function e2eeDelta(prev: E2eeTotals, next: E2eeTotals): E2eeStatsDto {
  return {
    framesEncrypted: delta(next.framesEncrypted, prev.framesEncrypted),
    framesDecrypted: delta(next.framesDecrypted, prev.framesDecrypted),
    framesFailed: delta(next.framesFailed, prev.framesFailed),
    framesMissingKey: delta(next.framesMissingKey, prev.framesMissingKey),
    envelopesDropped: delta(next.envelopesDropped, prev.envelopesDropped),
    securingSeconds: round(delta(next.securingSeconds, prev.securingSeconds)),
  };
}

/** Change of a cumulative counter; a counter that went down was reset (new stream, new worker): count from zero. */
function delta(next: number, prev: number | undefined): number {
  if (prev === undefined || next < prev) return Math.max(next, 0);
  return next - prev;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(value, 0) : 0;
}

function values(list: (number | undefined)[]): number[] {
  return list.filter((v): v is number => v !== undefined && Number.isFinite(v));
}

function average(list: number[]): number {
  return list.reduce((a, b) => a + b, 0) / list.length;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
