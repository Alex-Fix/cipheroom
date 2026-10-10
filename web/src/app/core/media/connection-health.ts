import { CallPlatform, E2eeStatsDto, TrackSource } from '../signaling/signaling.types';
import { IcePath, StatsLike, selectedIcePath } from './ice-path';
import { MediaState } from './media.types';

/**
 * The Connection drawer and the "Poor connection" chip: our own link to the SFU, from two `getStats()` readings
 * (docs/plans/2026-10-10-connection-diagnostics-design.md). Everything stays in this browser; `reportText` is what
 * "Copy report" puts on the clipboard — numbers only, no addresses, names or ids.
 */

/** Loss (either direction) from which the connection counts as poor. */
export const POOR_LOSS_PERCENT = 5;
/** Round-trip time from which the connection counts as poor. */
export const POOR_RTT_MS = 300;
/** Fewer packets than this in a reading: too few to judge loss. */
export const MIN_LOSS_PACKETS = 50;
/** Readings in a row before the chip shows (and good ones before it hides): about 10 s at one reading per 2 s. */
export const POOR_STREAK = 5;
/** A longer gap between readings (throttled tab): start over from the new reading. */
export const MAX_HEALTH_INTERVAL_MS = 10_000;

export type Verdict = 'good' | 'relay' | 'poor' | 'unknown';
export type Limitation = 'bandwidth' | 'cpu' | 'other';
export type SendStatus = 'on' | 'muted' | 'off' | 'paused';

interface Outbound {
  kind: string;
  mid?: string;
  rid?: string;
  bytes: number;
  packets: number;
  width?: number;
  height?: number;
  fps?: number;
  active?: boolean;
  limitation?: string;
  codec?: string;
}

interface Inbound {
  bytes: number;
  packets: number;
  packetsLost: number;
  jitterMs?: number;
}

/** One `getStats()` reading, reduced to what the drawer needs. */
export interface HealthSnapshot {
  /** ms (only differences matter). */
  at: number;
  ice?: IcePath;
  outbound: Map<string, Outbound>;
  inbound: Map<string, Inbound>;
  /** What the SFU says it lost of our streams (`remote-inbound-rtp`), by our outbound stream id. */
  remoteLost: Map<string, number>;
}

/** CryptoService's view for the Encryption section: counts and the key epoch, never key material. */
export interface EncryptionHealth {
  /** People in the call whose media key we hold, of `participants` (others, not us). */
  secured: number;
  participants: number;
  /** Our current sender key's epoch (rotates on join/leave); undefined before the first key. */
  epoch?: number;
  totals: E2eeStatsDto;
  /** Dropped key envelopes by reason (non-zero only). */
  dropped: Partial<Record<string, number>>;
}

/** What MediaService knows besides the stats. */
export interface HealthContext {
  state: MediaState;
  forceRelay: boolean;
  /** Our transceivers: mid → source. */
  sources: ReadonlyMap<string, TrackSource>;
  /** Devices turned on (mic unmuted, camera on, screen shared). */
  enabled: Record<TrackSource, boolean>;
  /** Usage guard: video may be sent. */
  videoAllowed: boolean;
  /** Camera height we aim for (the quality picker's tick). */
  targetHeight: number;
  encryption: EncryptionHealth;
}

export interface Route {
  relay: boolean;
  /** udp | tcp, to the media server or the TURN relay. */
  protocol: string;
  /** Transport to the TURN relay (udp | tcp | tls). */
  relayProtocol?: string;
  /** The media server's (or relay's) address — shown in the drawer, never copied. */
  remoteAddress?: string;
  rttMs?: number;
}

export interface Network {
  uploadKbps?: number;
  downloadKbps?: number;
  uploadLossPercent?: number;
  downloadLossPercent?: number;
  jitterMs?: number;
}

export interface SendingStream {
  source: TrackSource;
  status: SendStatus;
  codec?: string;
  /** Shorter side of the largest layer we send (720 for 1280×720 or a portrait 720×1280). */
  height?: number;
  fps?: number;
  kbps?: number;
  /** Simulcast layers actually sending (f, h, q). */
  layers?: string[];
  limitation?: Limitation;
}

export interface ConnectionReport {
  verdict: Verdict;
  /** Why it's poor (empty otherwise). */
  reasons: string[];
  state: MediaState;
  forceRelay: boolean;
  route?: Route;
  network: Network;
  sending: SendingStream[];
  encryption: EncryptionHealth;
}

export function healthSnapshot(report: StatsLike, at: number): HealthSnapshot {
  const outbound = new Map<string, Outbound>();
  const inbound = new Map<string, Inbound>();
  const remoteLost = new Map<string, number>();
  report.forEach((s) => {
    if (s.type === 'outbound-rtp') {
      const short = shortSide(s.frameWidth, s.frameHeight);
      outbound.set(s.id, {
        kind: s.kind,
        mid: typeof s.mid === 'string' ? s.mid : undefined,
        rid: typeof s.rid === 'string' ? s.rid : undefined,
        bytes: num(s.bytesSent),
        packets: num(s.packetsSent),
        height: short,
        fps: typeof s.framesPerSecond === 'number' ? s.framesPerSecond : undefined,
        active: typeof s.active === 'boolean' ? s.active : undefined,
        limitation:
          typeof s.qualityLimitationReason === 'string' ? s.qualityLimitationReason : undefined,
        codec: codecName(s.codecId ? report.get(s.codecId)?.mimeType : undefined),
      });
    } else if (s.type === 'inbound-rtp' && (s.kind === 'audio' || s.kind === 'video')) {
      inbound.set(s.id, {
        bytes: num(s.bytesReceived),
        packets: num(s.packetsReceived),
        packetsLost: num(s.packetsLost),
        jitterMs: typeof s.jitter === 'number' ? s.jitter * 1000 : undefined,
      });
    } else if (s.type === 'remote-inbound-rtp' && typeof s.localId === 'string') {
      remoteLost.set(s.localId, num(s.packetsLost));
    }
  });
  return { at, ice: selectedIcePath(report), outbound, inbound, remoteLost };
}

/**
 * The report for the reading `next` (rates over the interval since `prev`; none without `prev`), or `undefined`
 * when the interval is implausible — the caller keeps showing the last report and starts over from `next`.
 */
export function connectionReport(
  prev: HealthSnapshot | undefined,
  next: HealthSnapshot,
  context: HealthContext,
): ConnectionReport | undefined {
  const intervalMs = prev ? next.at - prev.at : undefined;
  if (intervalMs !== undefined && !(intervalMs > 0 && intervalMs <= MAX_HEALTH_INTERVAL_MS)) {
    return undefined;
  }
  const seconds = intervalMs !== undefined ? intervalMs / 1000 : undefined;

  const ice = next.ice;
  const route: Route | undefined = ice && {
    relay: ice.localType === 'relay',
    protocol: ice.protocol,
    relayProtocol: ice.localType === 'relay' ? ice.relayProtocol : undefined,
    remoteAddress: ice.remoteAddress,
    rttMs: ice.rttMs,
  };
  const network = prev && seconds ? networkOf(prev, next, seconds) : {};
  const sending = sendingOf(prev, next, seconds, context);

  const report: ConnectionReport = {
    verdict: 'unknown',
    reasons: [],
    state: context.state,
    forceRelay: context.forceRelay,
    route,
    network,
    sending,
    encryption: context.encryption,
  };
  if (context.state !== 'connected' || !route) return report;

  const reasons = poorReasons(route, network, sending, context.targetHeight);
  if (reasons.length) return { ...report, verdict: 'poor', reasons };
  return { ...report, verdict: route.relay ? 'relay' : 'good' };
}

/** The chip: shows after `POOR_STREAK` poor readings in a row, hides after as many others; `unknown` resets it. */
export class PoorStreak {
  private poor = 0;
  private fine = 0;
  private shown = false;

  update(verdict: Verdict): boolean {
    if (verdict === 'unknown') {
      this.poor = this.fine = 0;
      this.shown = false;
    } else if (verdict === 'poor') {
      this.fine = 0;
      if (++this.poor >= POOR_STREAK) this.shown = true;
    } else {
      this.poor = 0;
      if (++this.fine >= POOR_STREAK) this.shown = false;
    }
    return this.shown;
  }
}

/** The drawer's headline. */
export function verdictText(report: ConnectionReport): string {
  switch (report.verdict) {
    case 'good':
      return 'Good connection';
    case 'poor':
      return 'Poor connection';
    case 'relay':
      return `Connected through a relay (${upper(report.route?.relayProtocol) ?? 'TURN'})`;
    default:
      return report.state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  }
}

export function routeText(route: Route): string {
  return route.relay
    ? `Via TURN relay (${upper(route.relayProtocol) ?? upper(route.protocol)})`
    : `Direct to the media server (${upper(route.protocol)})`;
}

export function sourceText(source: TrackSource): string {
  return source === 'microphone' ? 'Microphone' : source === 'camera' ? 'Camera' : 'Screen';
}

/** One line for a sending stream, e.g. "VP9 · 1080p @ 30 fps · 1850 kbps · layers f h q". */
export function streamText(stream: SendingStream): string {
  switch (stream.status) {
    case 'muted':
      return 'Muted';
    case 'off':
      return 'Off';
    case 'paused':
      return 'Video paused by usage guard';
  }
  const parts = [
    stream.codec,
    stream.height !== undefined
      ? `${stream.height}p${stream.fps !== undefined ? ` @ ${Math.round(stream.fps)} fps` : ''}`
      : undefined,
    stream.kbps !== undefined ? `${stream.kbps} kbps` : undefined,
    stream.layers?.length ? `layers ${stream.layers.join(' ')}` : undefined,
  ];
  return parts.filter((p) => p !== undefined).join(' · ') || '—';
}

export function limitationText(limitation: Limitation | undefined): string {
  return limitation === 'bandwidth'
    ? 'bandwidth'
    : limitation === 'cpu'
      ? 'CPU'
      : limitation === 'other'
        ? 'other'
        : '—';
}

/** Whose media keys we hold. */
export function keysText(e: EncryptionHealth): string {
  return e.participants ? `from ${e.secured} of ${e.participants} people` : 'no one else here yet';
}

/** Dropped-envelope reasons, readable. */
export function dropText(reason: string): string {
  return reason.replace(/-/g, ' ');
}

/**
 * "Copy report": what the drawer shows, as plain text — no IP addresses, names, room id, participant ids or keys.
 */
export function reportText(report: ConnectionReport, platform: CallPlatform): string {
  const n = report.network;
  const e = report.encryption;
  const lines = [
    'Cipheroom connection report',
    `Browser: ${platform}`,
    `Status: ${verdictText(report)}`,
    ...report.reasons.map((r) => `  - ${r}`),
    '',
    'Route',
    `  ${report.route ? routeText(report.route) : '—'}`,
    `  Round trip: ${msText(report.route?.rttMs)}`,
    `  Relay forced by server: ${report.forceRelay ? 'yes' : 'no'}`,
    '',
    'Network',
    `  Upload: ${kbpsText(n.uploadKbps)}, loss ${percentText(n.uploadLossPercent)}`,
    `  Download: ${kbpsText(n.downloadKbps)}, loss ${percentText(n.downloadLossPercent)}`,
    `  Jitter: ${msText(n.jitterMs)}`,
    '',
    'Sending',
    ...report.sending.map(
      (s) =>
        `  ${sourceText(s.source)}: ${streamText(s)}` +
        (s.source !== 'microphone' && s.status === 'on'
          ? ` · limited by ${limitationText(s.limitation)}`
          : ''),
    ),
    '',
    'Encryption',
    `  Keys: ${keysText(e)}`,
    `  Key epoch: ${e.epoch ?? '—'}`,
    `  Frames: ${e.totals.framesEncrypted} encrypted, ${e.totals.framesDecrypted} decrypted, ` +
      `${e.totals.framesFailed} failed, ${e.totals.framesMissingKey} missing key`,
    ...Object.entries(e.dropped).map(
      ([reason, count]) => `  Dropped envelopes (${dropText(reason)}): ${count}`,
    ),
  ];
  return lines.join('\n');
}

function networkOf(prev: HealthSnapshot, next: HealthSnapshot, seconds: number): Network {
  let upBytes = 0;
  let upPackets = 0;
  let upLost = 0;
  next.outbound.forEach((o, id) => {
    const p = prev.outbound.get(id);
    upBytes += delta(o.bytes, p?.bytes);
    upPackets += delta(o.packets, p?.packets);
    const lost = next.remoteLost.get(id);
    if (lost !== undefined) upLost += delta(lost, prev.remoteLost.get(id));
  });
  let downBytes = 0;
  let downPackets = 0;
  let downLost = 0;
  const jitter: number[] = [];
  next.inbound.forEach((i, id) => {
    const p = prev.inbound.get(id);
    downBytes += delta(i.bytes, p?.bytes);
    downPackets += delta(i.packets, p?.packets);
    downLost += delta(i.packetsLost, p?.packetsLost);
    if (i.jitterMs !== undefined) jitter.push(i.jitterMs);
  });
  return {
    uploadKbps: next.outbound.size ? rate(upBytes, seconds) : undefined,
    downloadKbps: next.inbound.size ? rate(downBytes, seconds) : undefined,
    uploadLossPercent: next.remoteLost.size ? lossPercent(upLost, upPackets) : undefined,
    downloadLossPercent: next.inbound.size
      ? lossPercent(downLost, downPackets + downLost)
      : undefined,
    jitterMs: jitter.length
      ? Math.round(jitter.reduce((a, b) => a + b, 0) / jitter.length)
      : undefined,
  };
}

const SOURCES: readonly TrackSource[] = ['microphone', 'camera', 'screen'];
const LAYER_ORDER = ['f', 'h', 'q'];

function sendingOf(
  prev: HealthSnapshot | undefined,
  next: HealthSnapshot,
  seconds: number | undefined,
  context: HealthContext,
): SendingStream[] {
  const streams: SendingStream[] = [];
  for (const source of SOURCES) {
    // The screen row only while sharing.
    if (source === 'screen' && !context.enabled.screen) continue;
    const status: SendStatus =
      source !== 'microphone' && !context.videoAllowed
        ? 'paused'
        : context.enabled[source]
          ? 'on'
          : source === 'microphone'
            ? 'muted'
            : 'off';
    if (status !== 'on') {
      streams.push({ source, status });
      continue;
    }
    const encodings: (Outbound & { sent: number })[] = [];
    next.outbound.forEach((o, id) => {
      if (o.mid === undefined || context.sources.get(o.mid) !== source) return;
      encodings.push({ ...o, sent: delta(o.bytes, prev?.outbound.get(id)?.bytes) });
    });
    // Without a previous reading, every non-paused layer counts as sending.
    const sending = encodings.filter(
      (e) => e.active !== false && (prev === undefined || e.sent > 0),
    );
    const top = sending.reduce<(typeof sending)[number] | undefined>(
      (best, e) => (best === undefined || (e.height ?? 0) > (best.height ?? 0) ? e : best),
      undefined,
    );
    const layers = sending
      .map((e) => e.rid)
      .filter((rid): rid is string => !!rid)
      .sort((a, b) => LAYER_ORDER.indexOf(a) - LAYER_ORDER.indexOf(b));
    streams.push({
      source,
      status,
      codec: encodings.find((e) => e.codec)?.codec,
      height: top?.height,
      fps: top?.fps,
      kbps: seconds
        ? rate(
            encodings.reduce((sum, e) => sum + e.sent, 0),
            seconds,
          )
        : undefined,
      layers: source === 'microphone' || !layers.length ? undefined : layers,
      limitation: source === 'microphone' ? undefined : limitationOf(top?.limitation),
    });
  }
  return streams;
}

function poorReasons(
  route: Route,
  network: Network,
  sending: SendingStream[],
  targetHeight: number,
): string[] {
  const reasons: string[] = [];
  if ((network.uploadLossPercent ?? 0) >= POOR_LOSS_PERCENT) {
    reasons.push(`${network.uploadLossPercent}% packet loss sending`);
  }
  if ((network.downloadLossPercent ?? 0) >= POOR_LOSS_PERCENT) {
    reasons.push(`${network.downloadLossPercent}% packet loss receiving`);
  }
  if ((route.rttMs ?? 0) >= POOR_RTT_MS) reasons.push(`Slow round trip (${route.rttMs} ms)`);
  // Only the camera: screen shares ramp up slowly and often report "bandwidth" while fine.
  const camera = sending.find((s) => s.source === 'camera' && s.status === 'on');
  if (
    camera?.height !== undefined &&
    camera.height < targetHeight &&
    (camera.limitation === 'bandwidth' || camera.limitation === 'cpu')
  ) {
    const cause = camera.limitation === 'bandwidth' ? 'Slow upload' : 'Busy device (CPU)';
    reasons.push(`${cause} — sending ${camera.height}p instead of ${targetHeight}p`);
  }
  return reasons;
}

function limitationOf(reason: string | undefined): Limitation | undefined {
  if (reason === 'bandwidth' || reason === 'cpu' || reason === 'other') return reason;
  return undefined;
}

function lossPercent(lost: number, total: number): number | undefined {
  if (total < MIN_LOSS_PACKETS) return undefined;
  return Math.round((lost / total) * 1000) / 10;
}

function rate(bytes: number, seconds: number): number {
  return Math.round((bytes * 8) / seconds / 1000);
}

/** Change of a cumulative counter; one that went down was reset (new stream): count from zero. */
function delta(next: number, prev: number | undefined): number {
  if (prev === undefined || next < prev) return Math.max(next, 0);
  return next - prev;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(value, 0) : 0;
}

function shortSide(width: unknown, height: unknown): number | undefined {
  const sides = [width, height].filter((v): v is number => typeof v === 'number' && v > 0);
  return sides.length ? Math.min(...sides) : undefined;
}

/** "video/VP9" → "VP9", "audio/opus" → "Opus". */
function codecName(mimeType: unknown): string | undefined {
  if (typeof mimeType !== 'string') return undefined;
  const name = mimeType.slice(mimeType.indexOf('/') + 1);
  return name.toLowerCase() === 'opus' ? 'Opus' : name.toUpperCase();
}

function upper(value: string | undefined): string | undefined {
  return value?.toUpperCase();
}

export function kbpsText(value: number | undefined): string {
  return value !== undefined ? `${value} kbps` : '—';
}

export function percentText(value: number | undefined): string {
  return value !== undefined ? `${value}%` : '—';
}

export function msText(value: number | undefined): string {
  return value !== undefined ? `${value} ms` : '—';
}
