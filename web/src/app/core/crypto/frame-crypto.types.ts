// Messages between the page (FrameCrypto) and frame-crypto.worker.ts.
import { MediaKind, VideoFrameCodec } from './frame-codec';

export type EncodedFrame = RTCEncodedVideoFrame | RTCEncodedAudioFrame;

/** Options of each transform (RTCRtpScriptTransform options, or the message carrying the streams). */
export interface TransformOptions {
  /** Page-assigned, unique per sender/receiver of the call; used to retag a receiver. */
  id: number;
  side: 'send' | 'receive';
  kind: MediaKind;
  /** Receivers: whose keys decrypt it (unset until known — frames are dropped meanwhile). */
  participantId?: string;
  /** Debug (`?e2ee=passthrough`): receive without decrypting, to prove the SFU carries ciphertext. */
  passThrough?: boolean;
  /** Video senders: the negotiated codec, for browsers that don't report it per frame. */
  videoCodec?: VideoFrameCodec;
}

/** Page → worker. Sender keys are transferred (the page's buffer is detached), never copied. */
export type WorkerRequest =
  /** For browsers without RTCRtpScriptTransform (Chrome's createEncodedStreams). */
  | ({
      type: 'streams';
      readable: ReadableStream<EncodedFrame>;
      writable: WritableStream<EncodedFrame>;
    } & TransformOptions)
  /** The SFU reused a receiver for another participant's track. */
  | { type: 'retag'; id: number; participantId: string }
  | { type: 'setSendKey'; keyIndex: number; senderKey: ArrayBuffer }
  | { type: 'setReceiveKey'; participantId: string; keyIndex: number; senderKey: ArrayBuffer }
  | { type: 'removeParticipant'; participantId: string };

/** Worker → page, every few seconds; counts only, never frame contents or keys. */
export interface FrameStats {
  type: 'stats';
  encrypted: number;
  decrypted: number;
  failed: number;
  missingKey: number;
  unsupportedCodec: number;
  /** Key messages the worker rejected (bad index or length). */
  keyErrors: number;
  codecs: string[];
}
