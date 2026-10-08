import { InjectionToken } from '@angular/core';
import { passThroughRequested } from './e2ee-debug';
import { MediaKind } from './frame-codec';
import { FrameStats, TransformOptions, WorkerRequest } from './frame-crypto.types';

/** Chrome before RTCRtpScriptTransform: encoded streams, enabled per peer connection. */
interface LegacyEncodedStreams {
  createEncodedStreams(): { readable: ReadableStream; writable: WritableStream };
}

export type FrameTransformApi = 'script-transform' | 'encoded-streams';

/** Which encoded-transform API this browser has, if any. Without one it can't join encrypted calls. */
export function frameTransformApi(): FrameTransformApi | undefined {
  if (typeof RTCRtpScriptTransform !== 'undefined') return 'script-transform';
  if (typeof RTCRtpSender !== 'undefined' && 'createEncodedStreams' in RTCRtpSender.prototype) {
    return 'encoded-streams';
  }
  return undefined;
}

/**
 * Puts the frame-crypto worker on every sender and receiver of one peer connection, and hands it the call's keys.
 * Owned by MediaService for the call; components never use it.
 */
export class FrameCrypto {
  private readonly worker = new Worker(new URL('./frame-crypto.worker', import.meta.url), {
    type: 'module',
    name: 'frame-crypto',
  });
  private nextId = 0;
  /** Each sender/receiver's transform id and, for receivers, the participant it's tagged with. */
  private readonly attached = new WeakMap<
    RTCRtpSender | RTCRtpReceiver,
    { id: number; participantId?: string }
  >();

  constructor(
    private readonly api: FrameTransformApi,
    /** Debug (`?e2ee=passthrough`): receive without decrypting (proves the SFU carries ciphertext). */
    private readonly passThrough = false,
    onStats?: (stats: FrameStats) => void,
  ) {
    this.worker.addEventListener('message', ({ data }: MessageEvent<FrameStats>) => {
      if (data.type !== 'stats') return;
      this.latestStats = data;
      onStats?.(data);
    });
  }

  /** The worker's counters since it started (every few seconds; counts only). */
  latestStats?: FrameStats;

  /** Extra RTCPeerConnection settings this API needs. */
  get peerConnectionConfig(): object {
    return this.api === 'encoded-streams' ? { encodedInsertableStreams: true } : {};
  }

  /** Call right after addTransceiver, before the first frame is sent. Frames are dropped until a send key is set. */
  attachSender(sender: RTCRtpSender, kind: MediaKind): void {
    if (this.attached.has(sender)) return;
    this.attach(sender, { id: this.nextId++, side: 'send', kind });
  }

  /**
   * Call from ontrack (before the first frame is decoded) and whenever the SFU (re)assigns the receiver to a
   * participant's track. Frames are dropped until that participant's key arrives.
   */
  attachReceiver(receiver: RTCRtpReceiver, kind: MediaKind, participantId?: string): void {
    const existing = this.attached.get(receiver);
    if (!existing) {
      const options: TransformOptions = {
        id: this.nextId++,
        side: 'receive',
        kind,
        participantId,
        passThrough: this.passThrough,
      };
      this.attach(receiver, options);
      return;
    }
    if (participantId === undefined || existing.participantId === participantId) return;
    existing.participantId = participantId;
    this.post({ type: 'retag', id: existing.id, participantId });
  }

  /**
   * Switches our own encryption to this sender key (32 bytes). The buffer is transferred to the worker: it is
   * detached here afterwards, so no copy of the key stays on the page.
   */
  setSendKey(keyIndex: number, senderKey: ArrayBuffer): void {
    this.post({ type: 'setSendKey', keyIndex, senderKey }, [senderKey]);
  }

  /** Installs a participant's sender key (transferred, like `setSendKey`). Older keys stay usable briefly. */
  setReceiveKey(participantId: string, keyIndex: number, senderKey: ArrayBuffer): void {
    this.post({ type: 'setReceiveKey', participantId, keyIndex, senderKey }, [senderKey]);
  }

  /** Forgets a participant's keys (they left). */
  removeParticipant(participantId: string): void {
    this.post({ type: 'removeParticipant', participantId });
  }

  terminate(): void {
    this.worker.terminate();
  }

  private attach(target: RTCRtpSender | RTCRtpReceiver, options: TransformOptions): void {
    this.attached.set(target, { id: options.id, participantId: options.participantId });
    if (this.api === 'script-transform') {
      target.transform = new RTCRtpScriptTransform(this.worker, options);
      return;
    }
    const { readable, writable } = (
      target as unknown as LegacyEncodedStreams
    ).createEncodedStreams();
    this.post({ type: 'streams', readable, writable, ...options }, [readable, writable]);
  }

  private post(message: WorkerRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }
}

/** Creates the call's FrameCrypto (replaced in tests: the real one starts a worker). */
export const FRAME_CRYPTO_FACTORY = new InjectionToken<(api: FrameTransformApi) => FrameCrypto>(
  'FrameCryptoFactory',
  {
    factory: () => (api) => {
      const passThrough = passThroughRequested();
      // Counts and codec names only — never frame contents or keys.
      const log = (stats: FrameStats) =>
        console.info(`[cipheroom] e2ee passthrough (${api})`, stats);
      return new FrameCrypto(api, passThrough, passThrough ? log : undefined);
    },
  },
);
