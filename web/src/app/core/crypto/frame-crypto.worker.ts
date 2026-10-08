/// <reference lib="webworker" />
/**
 * Frame encryption for every sender and receiver of the call: one worker, shared by all transforms, so each send
 * key's IV counter is shared by all our tracks and never restarts while the key exists. Thin wiring only — the
 * logic is in FrameCryptor and Keyring.
 */
import { FrameCryptor, ReceiverState } from './frame-cryptor';
import { EncodedFrame, FrameStats, TransformOptions, WorkerRequest } from './frame-crypto.types';
import { Keyring } from './keyring';

declare const self: DedicatedWorkerGlobalScope;

const STATS_INTERVAL_MS = 5000;

const keyring = new Keyring();
const cryptor = new FrameCryptor(keyring);
const receivers = new Map<number, ReceiverState>();
let keyErrors = 0;
/** Key messages are applied in order: key imports are async, and a later key must never be overtaken. */
let keyUpdates = Promise.resolve();

self.addEventListener('rtctransform', (event: RTCTransformEvent) => {
  const { transformer } = event;
  pipe(
    transformer.readable as ReadableStream<EncodedFrame>,
    transformer.writable as WritableStream<EncodedFrame>,
    transformer.options as TransformOptions,
    () => void transformer.sendKeyFrameRequest().catch(() => undefined),
  );
});

self.addEventListener('message', ({ data }: MessageEvent<WorkerRequest>) => {
  switch (data.type) {
    case 'streams':
      pipe(data.readable, data.writable, data);
      break;
    case 'retag': {
      const receiver = receivers.get(data.id);
      if (receiver && receiver.participantId !== data.participantId) {
        receiver.participantId = data.participantId;
        receiver.failures = 0;
        // Whatever it decoded before belonged to someone else: start from a keyframe.
        receiver.waitingForKey = true;
        cryptor.keyArrived(data.participantId, [receiver]);
      }
      break;
    }
    case 'setSendKey':
      updateKeys(() => keyring.setSendKey(data.keyIndex, data.senderKey));
      break;
    case 'setReceiveKey':
      updateKeys(async () => {
        await keyring.setReceiveKey(data.participantId, data.keyIndex, data.senderKey);
        cryptor.keyArrived(data.participantId, receivers.values());
      });
      break;
    case 'removeParticipant':
      updateKeys(async () => keyring.removeParticipant(data.participantId));
      break;
  }
});

setInterval(() => {
  const { codecs, ...counts } = cryptor.stats;
  self.postMessage({
    type: 'stats',
    ...counts,
    keyErrors,
    codecs: [...codecs],
  } satisfies FrameStats);
}, STATS_INTERVAL_MS);

function updateKeys(update: () => Promise<void>): void {
  keyUpdates = keyUpdates.then(update).catch(() => void keyErrors++);
}

function pipe(
  readable: ReadableStream<EncodedFrame>,
  writable: WritableStream<EncodedFrame>,
  options: TransformOptions,
  requestKeyFrame?: () => void,
): void {
  let transform: (frame: EncodedFrame) => Promise<EncodedFrame | undefined>;
  let receiver: ReceiverState | undefined;
  if (options.side === 'send') {
    transform = (frame) => cryptor.encrypt(options.kind, frame, options.videoCodec);
  } else {
    const state: ReceiverState = {
      kind: options.kind,
      participantId: options.participantId,
      passThrough: options.passThrough,
      waitingForKey: false,
      failures: 0,
      lastKeyFrameRequest: 0,
      requestKeyFrame,
    };
    receiver = state;
    receivers.set(options.id, state);
    transform = (frame) => cryptor.decrypt(state, frame);
  }
  void readable
    .pipeThrough(
      new TransformStream<EncodedFrame, EncodedFrame>({
        async transform(frame, out) {
          const result = await transform(frame);
          if (result) out.enqueue(result);
        },
      }),
    )
    .pipeTo(writable)
    .catch(() => undefined) // the transceiver stopped
    .finally(() => {
      if (receiver && receivers.get(options.id) === receiver) receivers.delete(options.id);
    });
}
