import { fromBase64Url } from './encoding';
import {
  createDeviceKey,
  deviceKeyFrom,
  signDeviceStatement,
  verifyDeviceStatement,
  wipeDeviceMaterial,
} from './device-key';
import { MemoryDeviceKeyStore } from './device-key-store';
import { createIdentity } from './identity';

const ROOM = 'team-sync';

describe('device key', () => {
  it('is created non-extractable, with a one-time exportable copy that restores the same key', async () => {
    const { deviceKey, material } = await createDeviceKey(1000);
    expect(deviceKey.signing.extractable).toBe(false);
    expect(fromBase64Url(deviceKey.pub).byteLength).toBe(32);
    expect(deviceKey.createdAt).toBe(1000);

    const restored = await deviceKeyFrom({ pkcs8: material.pkcs8.slice() });
    expect(restored.pub).toBe(deviceKey.pub);

    wipeDeviceMaterial(material);
    expect(material.pkcs8.every((b) => b === 0)).toBe(true);
  });

  it('vouches for one per-call identity in one room only', async () => {
    const { deviceKey } = await createDeviceKey();
    const [me, someoneElse] = [await createIdentity(ROOM), await createIdentity(ROOM)];
    const devicePub = fromBase64Url(deviceKey.pub);
    const sig = await signDeviceStatement(deviceKey, ROOM, me.bundle.ed25519Pub);

    expect(await verifyDeviceStatement(devicePub, ROOM, me.bundle.ed25519Pub, sig)).toBe(true);
    // Replayed for another per-call identity, or into another room: no.
    expect(await verifyDeviceStatement(devicePub, ROOM, someoneElse.bundle.ed25519Pub, sig)).toBe(
      false,
    );
    expect(await verifyDeviceStatement(devicePub, 'other-room', me.bundle.ed25519Pub, sig)).toBe(
      false,
    );
    // Another device key, or garbage: no.
    const other = fromBase64Url((await createDeviceKey()).deviceKey.pub);
    expect(await verifyDeviceStatement(other, ROOM, me.bundle.ed25519Pub, sig)).toBe(false);
    expect(
      await verifyDeviceStatement(
        new Uint8Array(32),
        ROOM,
        me.bundle.ed25519Pub,
        new Uint8Array(64),
      ),
    ).toBe(false);
  });

  it('MemoryDeviceKeyStore keeps one key', async () => {
    const store = new MemoryDeviceKeyStore();
    expect(await store.get()).toBeUndefined();
    const { deviceKey } = await createDeviceKey();
    await store.put(deviceKey);
    expect(await store.get()).toBe(deviceKey);
    await store.delete();
    expect(await store.get()).toBeUndefined();
  });
});
