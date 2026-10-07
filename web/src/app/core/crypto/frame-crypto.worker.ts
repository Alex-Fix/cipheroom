/// <reference lib="webworker" />
/**
 * Frame encryption for every sender and receiver of the call: one worker, shared by all transforms, so the IV
 * counter is per key and never restarts while the key exists.
 *
 * SPIKE (step 1 of docs/plans/2026-10-07-e2ee-media-design.md): a fixed, public test key — this proves only that
 * Cloudflare's SFU forwards encrypted frames; it protects nothing. Real sender keys arrive in step 2–5.
 */
import { decryptFrame, encryptFrame, isSupportedCodec } from './frame-codec';
import { EncodedFrame, FrameStats, StreamsMessage, TransformOptions } from './frame-crypto.types';

declare const self: DedicatedWorkerGlobalScope;

const KEY_INDEX = 0;
const STATS_INTERVAL_MS = 5000;

const testKey = deriveTestKey();
let counter = 0n;
const stats = { encrypted: 0, decrypted: 0, failed: 0, dropped: 0, codecs: new Set<string>() };

self.addEventListener('rtctransform', (event: RTCTransformEvent) => {
  const { readable, writable, options } = event.transformer;
  pipe(
    readable as ReadableStream<EncodedFrame>,
    writable as WritableStream<EncodedFrame>,
    options as TransformOptions,
  );
});

self.addEventListener('message', ({ data }: MessageEvent<StreamsMessage>) => {
  if (data.type === 'streams') pipe(data.readable, data.writable, data);
});

setInterval(() => {
  self.postMessage({ type: 'stats', ...stats, codecs: [...stats.codecs] } satisfies FrameStats);
}, STATS_INTERVAL_MS);

function pipe(
  readable: ReadableStream<EncodedFrame>,
  writable: WritableStream<EncodedFrame>,
  options: TransformOptions,
): void {
  const transform = options.side === 'send' ? encrypt : decrypt;
  void readable
    .pipeThrough(
      new TransformStream<EncodedFrame, EncodedFrame>({
        transform: (frame, out) => transform(frame, out, options),
      }),
    )
    .pipeTo(writable)
    .catch(() => undefined); // the transceiver stopped
}

async function encrypt(
  frame: EncodedFrame,
  out: TransformStreamDefaultController<EncodedFrame>,
  { kind }: TransformOptions,
): Promise<void> {
  if (frame.data.byteLength === 0) return out.enqueue(frame);
  const codec = frame.getMetadata().mimeType;
  if (codec) stats.codecs.add(`send ${codec}`);
  // Never send what we can't encrypt.
  if (!isSupportedCodec(kind, codec)) {
    stats.dropped++;
    return;
  }
  frame.data = (
    await encryptFrame(kind, new Uint8Array(frame.data), await testKey, KEY_INDEX, counter++)
  ).buffer;
  stats.encrypted++;
  out.enqueue(frame);
}

async function decrypt(
  frame: EncodedFrame,
  out: TransformStreamDefaultController<EncodedFrame>,
  { kind, passThrough }: TransformOptions,
): Promise<void> {
  if (frame.data.byteLength === 0 || passThrough) return out.enqueue(frame);
  const codec = frame.getMetadata().mimeType;
  if (codec) stats.codecs.add(`receive ${codec}`);
  try {
    frame.data = (await decryptFrame(kind, new Uint8Array(frame.data), await testKey)).buffer;
    stats.decrypted++;
    out.enqueue(frame);
  } catch {
    stats.failed++; // tampered, wrong key, or not encrypted: drop
  }
}

async function deriveTestKey(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('cipheroom spike test key — not secret'),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode('cipheroom/media/v1'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
