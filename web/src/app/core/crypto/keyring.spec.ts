import { encryptFrame } from './frame-codec';
import { Keyring, PREVIOUS_KEY_GRACE_MS } from './keyring';

const senderKey = () => crypto.getRandomValues(new Uint8Array(32)).buffer;

describe('Keyring', () => {
  let now: number;
  let keyring: Keyring;

  beforeEach(() => {
    now = 1_000;
    keyring = new Keyring(() => now);
  });

  it('has no send key until one is set', () => {
    expect(keyring.nextSend()).toBeUndefined();
  });

  it('counts frames per send key and restarts the counter with a new key', async () => {
    await keyring.setSendKey(3, senderKey());
    expect(keyring.nextSend()).toMatchObject({ keyIndex: 3, counter: 0n });
    expect(keyring.nextSend()).toMatchObject({ keyIndex: 3, counter: 1n });

    await keyring.setSendKey(4, senderKey());
    expect(keyring.nextSend()).toMatchObject({ keyIndex: 4, counter: 0n });
  });

  it('derives the same media key on both sides from the same sender key', async () => {
    const raw = new Uint8Array(senderKey());
    await keyring.setSendKey(1, raw.slice().buffer);
    await keyring.setReceiveKey('alice', 1, raw.slice().buffer);
    const send = keyring.nextSend()!;
    const frame = await encryptFrame('audio', new Uint8Array(40), send.key, 1, send.counter);

    const receiveKey = keyring.receiveKey('alice', 1)!;
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(12), additionalData: frame.subarray(-9) },
      receiveKey,
      frame.subarray(0, -9),
    );
    expect(new Uint8Array(decrypted)).toEqual(new Uint8Array(40));
  });

  it('creates non-extractable media keys', async () => {
    await keyring.setSendKey(0, senderKey());
    await keyring.setReceiveKey('alice', 0, senderKey());
    expect(keyring.nextSend()!.key.extractable).toBe(false);
    expect(keyring.receiveKey('alice', 0)!.extractable).toBe(false);
  });

  it('keeps receive keys per participant and key index', async () => {
    await keyring.setReceiveKey('alice', 0, senderKey());
    expect(keyring.receiveKey('alice', 0)).toBeDefined();
    expect(keyring.receiveKey('alice', 1)).toBeUndefined();
    expect(keyring.receiveKey('bob', 0)).toBeUndefined();
  });

  it('keeps a participant’s previous key only for the grace period after a newer one arrives', async () => {
    await keyring.setReceiveKey('alice', 0, senderKey());
    now += 60_000; // the current key never expires on its own
    expect(keyring.receiveKey('alice', 0)).toBeDefined();

    await keyring.setReceiveKey('alice', 1, senderKey());
    now += PREVIOUS_KEY_GRACE_MS - 1;
    expect(keyring.receiveKey('alice', 0)).toBeDefined();
    now += 1;
    expect(keyring.receiveKey('alice', 0)).toBeUndefined();
    expect(keyring.receiveKey('alice', 1)).toBeDefined();
  });

  it('forgets everything about a participant who left', async () => {
    await keyring.setReceiveKey('alice', 0, senderKey());
    keyring.removeParticipant('alice');
    expect(keyring.receiveKey('alice', 0)).toBeUndefined();
  });

  it('rejects bad key indexes and key lengths', async () => {
    await expect(keyring.setSendKey(16, senderKey())).rejects.toThrow('Invalid key index.');
    await expect(keyring.setSendKey(-1, senderKey())).rejects.toThrow('Invalid key index.');
    await expect(keyring.setReceiveKey('alice', 0, new ArrayBuffer(16))).rejects.toThrow(
      'Invalid sender key.',
    );
  });
});
