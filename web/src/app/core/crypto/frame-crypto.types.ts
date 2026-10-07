// Messages between the page and frame-crypto.worker.ts.
import { MediaKind } from './frame-codec';

export type EncodedFrame = RTCEncodedVideoFrame | RTCEncodedAudioFrame;

/** Options of each transform (RTCRtpScriptTransform options, or the message carrying the streams). */
export interface TransformOptions {
  side: 'send' | 'receive';
  kind: MediaKind;
  /** Spike only: receive without decrypting, to prove the SFU carries ciphertext. */
  passThrough?: boolean;
}

/** Message for browsers without RTCRtpScriptTransform (Chrome's createEncodedStreams). */
export interface StreamsMessage extends TransformOptions {
  type: 'streams';
  readable: ReadableStream<EncodedFrame>;
  writable: WritableStream<EncodedFrame>;
}

/** Posted to the page every few seconds; counts only, never frame contents or keys. */
export interface FrameStats {
  type: 'stats';
  encrypted: number;
  decrypted: number;
  failed: number;
  dropped: number;
  codecs: string[];
}
