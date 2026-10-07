import { MediaKind } from './frame-codec';
import {
  FAILURES_BEFORE_KEYFRAME_REQUEST,
  Frame,
  FrameCryptor,
  KEYFRAME_REQUEST_INTERVAL_MS,
  ReceiverState,
} from './frame-cryptor';
import { Keyring } from './keyring';

const senderKey = () => crypto.getRandomValues(new Uint8Array(32)).buffer;
const copy = (key: ArrayBuffer) => key.slice(0);

function frame(bytes: Uint8Array, mimeType?: string): Frame {
  return { data: bytes.slice().buffer, getMetadata: () => ({ mimeType }) };
}

/** A VP8 delta frame (P bit set). */
function vp8Delta(): Uint8Array {
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  bytes[0] |= 0x01;
  return bytes;
}

function receiver(kind: MediaKind, participantId?: string): ReceiverState {
  return {
    kind,
    participantId,
    waitingForKey: false,
    failures: 0,
    lastKeyFrameRequest: 0,
    requestKeyFrame: vi.fn(),
  };
}

describe('FrameCryptor', () => {
  let now: number;
  let alice: FrameCryptor;
  let aliceKeys: Keyring;
  let bob: FrameCryptor;
  let bobKeys: Keyring;
  let key: ArrayBuffer;

  beforeEach(async () => {
    now = 10_000;
    aliceKeys = new Keyring(() => now);
    bobKeys = new Keyring(() => now);
    alice = new FrameCryptor(aliceKeys, () => now);
    bob = new FrameCryptor(bobKeys, () => now);
    key = senderKey();
    await aliceKeys.setSendKey(2, copy(key));
  });

  async function aliceSends(kind: MediaKind, bytes: Uint8Array): Promise<Frame> {
    return (await alice.encrypt(kind, frame(bytes)))!;
  }

  it('delivers frames from sender to receiver once the receiver has the sender’s key', async () => {
    await bobKeys.setReceiveKey('alice', 2, copy(key));
    const original = vp8Delta();
    const sent = await aliceSends('video', original);
    expect(new Uint8Array(sent.data)).not.toEqual(original);

    const received = await bob.decrypt(receiver('video', 'alice'), sent);
    expect(new Uint8Array(received!.data)).toEqual(original);
    expect(alice.stats.encrypted).toBe(1);
    expect(bob.stats.decrypted).toBe(1);
  });

  it('drops outgoing frames until we have a send key — never sends plaintext', async () => {
    const noKey = new FrameCryptor(new Keyring());
    expect(await noKey.encrypt('audio', frame(new Uint8Array(40)))).toBeUndefined();
    expect(noKey.stats.missingKey).toBe(1);
  });

  it('drops outgoing frames of codecs the frame layout doesn’t support', async () => {
    expect(await alice.encrypt('video', frame(vp8Delta(), 'video/H264'))).toBeUndefined();
    expect(alice.stats.unsupportedCodec).toBe(1);
    expect(alice.stats.codecs).toContain('send video/H264');
  });

  it('passes empty frames through', async () => {
    const empty = frame(new Uint8Array(0));
    expect(await alice.encrypt('video', empty)).toBe(empty);
    expect(await bob.decrypt(receiver('video', 'alice'), empty)).toBe(empty);
  });

  it('drops frames while the sender’s key is missing, then asks for a keyframe when it arrives', async () => {
    const r = receiver('video', 'alice');
    expect(await bob.decrypt(r, await aliceSends('video', vp8Delta()))).toBeUndefined();
    expect(r.waitingForKey).toBe(true);
    expect(bob.stats.missingKey).toBe(1);

    await bobKeys.setReceiveKey('alice', 2, copy(key));
    bob.keyArrived('alice', [r, receiver('video', 'carol')]);
    expect(r.requestKeyFrame).toHaveBeenCalledTimes(1);
    expect(r.waitingForKey).toBe(false);
  });

  it('drops frames on untagged receivers (participant not known yet)', async () => {
    await bobKeys.setReceiveKey('alice', 2, copy(key));
    expect(
      await bob.decrypt(receiver('video'), await aliceSends('video', vp8Delta())),
    ).toBeUndefined();
  });

  it('never decrypts one participant’s frames with another’s key', async () => {
    await bobKeys.setReceiveKey('carol', 2, copy(key));
    const r = receiver('audio', 'alice');
    expect(await bob.decrypt(r, await aliceSends('audio', new Uint8Array(40)))).toBeUndefined();
  });

  it('drops frames that fail authentication and asks for a keyframe after repeated failures', async () => {
    await bobKeys.setReceiveKey('alice', 2, senderKey()); // a different key under the same index
    const r = receiver('video', 'alice');
    for (let i = 0; i < FAILURES_BEFORE_KEYFRAME_REQUEST; i++) {
      expect(await bob.decrypt(r, await aliceSends('video', vp8Delta()))).toBeUndefined();
    }
    expect(bob.stats.failed).toBe(FAILURES_BEFORE_KEYFRAME_REQUEST);
    expect(r.requestKeyFrame).toHaveBeenCalledTimes(1);
  });

  it('rate-limits keyframe requests', async () => {
    const r = receiver('video', 'alice');
    const keyArrives = () => {
      r.waitingForKey = true;
      bob.keyArrived('alice', [r]);
    };
    keyArrives();
    keyArrives();
    expect(r.requestKeyFrame).toHaveBeenCalledTimes(1);

    now += KEYFRAME_REQUEST_INTERVAL_MS;
    keyArrives();
    expect(r.requestKeyFrame).toHaveBeenCalledTimes(2);
  });

  it('never asks audio receivers for keyframes', async () => {
    const r = receiver('audio', 'alice');
    r.waitingForKey = true;
    bob.keyArrived('alice', [r]);
    expect(r.requestKeyFrame).not.toHaveBeenCalled();
  });

  it('keeps decrypting with the previous key during a rotation', async () => {
    await bobKeys.setReceiveKey('alice', 2, copy(key));
    const inFlight = await aliceSends('audio', new Uint8Array(40));

    const next = senderKey();
    await aliceKeys.setSendKey(3, copy(next));
    await bobKeys.setReceiveKey('alice', 3, copy(next));
    const r = receiver('audio', 'alice');
    expect(await bob.decrypt(r, inFlight)).toBeDefined();
    expect(await bob.decrypt(r, await aliceSends('audio', new Uint8Array(40)))).toBeDefined();
  });

  it('passes received frames through undecrypted in pass-through mode (spike)', async () => {
    const sent = await aliceSends('audio', new Uint8Array(40));
    const before = new Uint8Array(sent.data).slice();
    const r = { ...receiver('audio', 'alice'), passThrough: true };
    expect(new Uint8Array((await bob.decrypt(r, sent))!.data)).toEqual(before);
  });
});
