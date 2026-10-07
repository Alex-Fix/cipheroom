import { FrameCrypto, frameTransformApi } from './frame-transforms';
import { WorkerRequest } from './frame-crypto.types';

class FakeWorker {
  static last: FakeWorker;
  readonly posted: { message: WorkerRequest; transfer: Transferable[] }[] = [];
  terminated = false;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(message: WorkerRequest, transfer: Transferable[]) {
    this.posted.push({ message, transfer });
  }
  addEventListener() {}
  terminate() {
    this.terminated = true;
  }
}

class FakeScriptTransform {
  constructor(
    readonly worker: unknown,
    readonly options: unknown,
  ) {}
}

const messages = () => FakeWorker.last.posted.map((p) => p.message);

describe('FrameCrypto', () => {
  beforeEach(() => vi.stubGlobal('Worker', FakeWorker));
  afterEach(() => vi.unstubAllGlobals());

  describe('with RTCRtpScriptTransform', () => {
    beforeEach(() => vi.stubGlobal('RTCRtpScriptTransform', FakeScriptTransform));

    it('is the preferred API', () => {
      expect(frameTransformApi()).toBe('script-transform');
      expect(new FrameCrypto('script-transform').peerConnectionConfig).toEqual({});
    });

    it('puts the worker on senders once', () => {
      const crypto = new FrameCrypto('script-transform');
      const sender = {} as RTCRtpSender;
      crypto.attachSender(sender, 'video');
      const transform = sender.transform as unknown as FakeScriptTransform;
      crypto.attachSender(sender, 'video');

      expect(transform.worker).toBe(FakeWorker.last);
      expect(transform.options).toEqual({ id: 0, side: 'send', kind: 'video' });
      expect(sender.transform).toBe(transform);
    });

    it('tags receivers with their participant and retags them when the SFU reuses them', () => {
      const crypto = new FrameCrypto('script-transform', true);
      const receiver = {} as RTCRtpReceiver;
      crypto.attachReceiver(receiver, 'audio');
      expect((receiver.transform as unknown as FakeScriptTransform).options).toEqual({
        id: 0,
        side: 'receive',
        kind: 'audio',
        participantId: undefined,
        passThrough: true,
      });

      crypto.attachReceiver(receiver, 'audio', 'bob');
      crypto.attachReceiver(receiver, 'audio', 'bob');
      crypto.attachReceiver(receiver, 'audio', 'carol');
      expect(messages()).toEqual([
        { type: 'retag', id: 0, participantId: 'bob' },
        { type: 'retag', id: 0, participantId: 'carol' },
      ]);
    });

    it('transfers sender keys to the worker instead of copying them', () => {
      const crypto = new FrameCrypto('script-transform');
      const sendKey = new ArrayBuffer(32);
      const bobKey = new ArrayBuffer(32);
      crypto.setSendKey(1, sendKey);
      crypto.setReceiveKey('bob', 2, bobKey);
      crypto.removeParticipant('bob');

      expect(FakeWorker.last.posted).toEqual([
        { message: { type: 'setSendKey', keyIndex: 1, senderKey: sendKey }, transfer: [sendKey] },
        {
          message: { type: 'setReceiveKey', participantId: 'bob', keyIndex: 2, senderKey: bobKey },
          transfer: [bobKey],
        },
        { message: { type: 'removeParticipant', participantId: 'bob' }, transfer: [] },
      ]);
    });

    it('stops the worker with the call', () => {
      new FrameCrypto('script-transform').terminate();
      expect(FakeWorker.last.terminated).toBe(true);
    });
  });

  describe('with encoded streams (Chrome without RTCRtpScriptTransform)', () => {
    it('is the fallback API and needs encodedInsertableStreams', () => {
      vi.stubGlobal('RTCRtpScriptTransform', undefined);
      vi.stubGlobal(
        'RTCRtpSender',
        class {
          createEncodedStreams() {}
        },
      );
      expect(frameTransformApi()).toBe('encoded-streams');
      expect(new FrameCrypto('encoded-streams').peerConnectionConfig).toEqual({
        encodedInsertableStreams: true,
      });
    });

    it('hands the sender’s streams to the worker', () => {
      const readable = {} as ReadableStream;
      const writable = {} as WritableStream;
      const sender = { createEncodedStreams: vi.fn(() => ({ readable, writable })) };
      const crypto = new FrameCrypto('encoded-streams');
      crypto.attachSender(sender as unknown as RTCRtpSender, 'audio');

      expect(FakeWorker.last.posted).toEqual([
        {
          message: { type: 'streams', readable, writable, id: 0, side: 'send', kind: 'audio' },
          transfer: [readable, writable],
        },
      ]);
    });
  });

  it('is unavailable without encoded transforms', () => {
    vi.stubGlobal('RTCRtpScriptTransform', undefined);
    vi.stubGlobal('RTCRtpSender', class {});
    expect(frameTransformApi()).toBeUndefined();
  });
});
