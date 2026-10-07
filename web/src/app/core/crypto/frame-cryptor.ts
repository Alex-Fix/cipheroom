import {
  MediaKind,
  decryptFrame,
  encryptFrame,
  frameKeyIndex,
  isSupportedCodec,
} from './frame-codec';
import { Keyring } from './keyring';

/** What the cryptor needs of an encoded frame (RTCEncodedVideoFrame / RTCEncodedAudioFrame). */
export interface Frame {
  data: ArrayBuffer;
  getMetadata(): { mimeType?: string };
}

/** One receiver's transform, as the worker tracks it. */
export interface ReceiverState {
  kind: MediaKind;
  /** Whose keys decrypt this receiver; unset until the page knows (frames are dropped meanwhile). */
  participantId?: string;
  /** Spike only: receive without decrypting (proves the SFU carries ciphertext). */
  passThrough?: boolean;
  /** Frames were dropped for lack of a key: ask for a keyframe once it arrives. */
  waitingForKey: boolean;
  /** Consecutive failures with a key we have (tampering, corruption, or a sender we got the wrong key for). */
  failures: number;
  lastKeyFrameRequest: number;
  /** Asks the sender for a keyframe (video, RTCRtpScriptTransform only). */
  requestKeyFrame?: () => void;
}

/** Counts only — never frame contents or keys. */
export interface CryptorStats {
  encrypted: number;
  decrypted: number;
  /** Decryption failed with a key we have. */
  failed: number;
  /** Dropped for lack of a key (ours not set yet, or the sender's not received yet). */
  missingKey: number;
  /** Not sent: a codec the frame layout doesn't support. */
  unsupportedCodec: number;
  codecs: Set<string>;
}

export const FAILURES_BEFORE_KEYFRAME_REQUEST = 10;
export const KEYFRAME_REQUEST_INTERVAL_MS = 1000;

/** Per-frame encryption and decryption against the keyring. Returns the frame to pass on, or `undefined` to drop it. */
export class FrameCryptor {
  readonly stats: CryptorStats = {
    encrypted: 0,
    decrypted: 0,
    failed: 0,
    missingKey: 0,
    unsupportedCodec: 0,
    codecs: new Set(),
  };

  constructor(
    private readonly keyring: Keyring,
    private readonly now: () => number = Date.now,
  ) {}

  async encrypt<F extends Frame>(kind: MediaKind, frame: F): Promise<F | undefined> {
    if (frame.data.byteLength === 0) return frame;
    const codec = frame.getMetadata().mimeType;
    if (codec) this.stats.codecs.add(`send ${codec}`);
    // Never send what we can't encrypt.
    if (!isSupportedCodec(kind, codec)) {
      this.stats.unsupportedCodec++;
      return undefined;
    }
    const send = this.keyring.nextSend();
    if (!send) {
      this.stats.missingKey++;
      return undefined;
    }
    const data = new Uint8Array(frame.data);
    frame.data = (await encryptFrame(kind, data, send.key, send.keyIndex, send.counter)).buffer;
    this.stats.encrypted++;
    return frame;
  }

  async decrypt<F extends Frame>(receiver: ReceiverState, frame: F): Promise<F | undefined> {
    if (frame.data.byteLength === 0 || receiver.passThrough) return frame;
    const codec = frame.getMetadata().mimeType;
    if (codec) this.stats.codecs.add(`receive ${codec}`);
    const data = new Uint8Array(frame.data);
    const keyIndex = frameKeyIndex(receiver.kind, data);
    const key =
      receiver.participantId !== undefined && keyIndex !== undefined
        ? this.keyring.receiveKey(receiver.participantId, keyIndex)
        : undefined;
    if (!key) {
      this.stats.missingKey++;
      receiver.waitingForKey = true;
      return undefined;
    }
    try {
      frame.data = (await decryptFrame(receiver.kind, data, key)).buffer;
    } catch {
      this.stats.failed++;
      if (++receiver.failures >= FAILURES_BEFORE_KEYFRAME_REQUEST) this.requestKeyFrame(receiver);
      return undefined;
    }
    receiver.failures = 0;
    this.stats.decrypted++;
    return frame;
  }

  /**
   * A key for `participantId` arrived: receivers that were dropping frames resume with a keyframe (delta frames
   * alone can't be decoded without the frames we dropped).
   */
  keyArrived(participantId: string, receivers: Iterable<ReceiverState>): void {
    for (const r of receivers) {
      if (r.participantId !== participantId || !r.waitingForKey) continue;
      r.waitingForKey = false;
      this.requestKeyFrame(r);
    }
  }

  private requestKeyFrame(receiver: ReceiverState): void {
    if (receiver.kind !== 'video' || !receiver.requestKeyFrame) return;
    const now = this.now();
    if (now - receiver.lastKeyFrameRequest < KEYFRAME_REQUEST_INTERVAL_MS) return;
    receiver.lastKeyFrameRequest = now;
    receiver.failures = 0;
    receiver.requestKeyFrame();
  }
}
