import { MediaKind } from './frame-codec';
import { FrameStats, StreamsMessage, TransformOptions } from './frame-crypto.types';

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
 * Puts the frame-crypto worker on every sender and receiver of one peer connection. Owned by MediaService for the
 * call; components never use it.
 */
export class FrameCrypto {
  private readonly worker = new Worker(new URL('./frame-crypto.worker', import.meta.url), {
    type: 'module',
    name: 'frame-crypto',
  });
  private readonly attached = new WeakSet<RTCRtpSender | RTCRtpReceiver>();

  constructor(
    private readonly api: FrameTransformApi,
    /** Spike only: receive without decrypting (proves the SFU carries ciphertext). */
    private readonly passThrough = false,
    onStats?: (stats: FrameStats) => void,
  ) {
    this.worker.addEventListener('message', ({ data }: MessageEvent<FrameStats>) => {
      if (data.type === 'stats') onStats?.(data);
    });
  }

  /** Extra RTCPeerConnection settings this API needs. */
  get peerConnectionConfig(): object {
    return this.api === 'encoded-streams' ? { encodedInsertableStreams: true } : {};
  }

  /** Call right after addTransceiver, before the first frame is sent. */
  attachSender(sender: RTCRtpSender, kind: MediaKind): void {
    this.attach(sender, { side: 'send', kind });
  }

  /** Call from ontrack, before the first frame is decoded. */
  attachReceiver(receiver: RTCRtpReceiver, kind: MediaKind): void {
    this.attach(receiver, { side: 'receive', kind, passThrough: this.passThrough });
  }

  terminate(): void {
    this.worker.terminate();
  }

  private attach(target: RTCRtpSender | RTCRtpReceiver, options: TransformOptions): void {
    if (this.attached.has(target)) return;
    this.attached.add(target);
    if (this.api === 'script-transform') {
      target.transform = new RTCRtpScriptTransform(this.worker, options);
      return;
    }
    const { readable, writable } = (
      target as unknown as LegacyEncodedStreams
    ).createEncodedStreams();
    const message: StreamsMessage = { type: 'streams', readable, writable, ...options };
    this.worker.postMessage(message, [readable, writable]);
  }
}
