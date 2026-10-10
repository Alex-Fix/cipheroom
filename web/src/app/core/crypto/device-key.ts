import { fields, fromBase64Url, toBase64Url } from './encoding';
import { publicKeyOf } from './host-key';
import { verify } from './statements';

/**
 * This browser's long-term device key (design: docs/plans/2026-10-10-contacts-tofu-design.md): Ed25519, kept
 * non-extractable. It never reaches the server: it signs each per-call identity, and that statement travels only
 * inside the encrypted key envelopes, so people we call can recognise us in later calls while the server keeps seeing
 * unlinkable per-call keys.
 */
export interface DeviceKey {
  /** The store's key: there is one device key per browser. */
  id: 'device';
  signing: CryptoKey;
  /** Ed25519 public key, base64url. */
  pub: string;
  createdAt: number;
}

/** The private key as PKCS#8, only right after creation (for the one-time backup) or while restoring one. */
export interface DeviceKeyMaterial {
  pkcs8: Uint8Array<ArrayBuffer>;
}

const DEVICE_LABEL = 'cipheroom/device/v1';

/** A new device key, stored non-extractable. `material` is the only exportable copy: back it up, then wipe it. */
export async function createDeviceKey(
  now = Date.now(),
): Promise<{ deviceKey: DeviceKey; material: DeviceKeyMaterial }> {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const material = {
    pkcs8: new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  };
  return { deviceKey: await deviceKeyFrom(material, now), material };
}

/** A non-extractable device key from its private key (creation or a backup). */
export async function deviceKeyFrom(
  material: DeviceKeyMaterial,
  now = Date.now(),
): Promise<DeviceKey> {
  const pub = await publicKeyOf(material.pkcs8, 'Ed25519', ['sign']);
  return {
    id: 'device',
    signing: await crypto.subtle.importKey('pkcs8', material.pkcs8, 'Ed25519', false, ['sign']),
    pub: toBase64Url(pub),
    createdAt: now,
  };
}

export function wipeDeviceMaterial(material: DeviceKeyMaterial): void {
  material.pkcs8.fill(0);
}

/** What the device key signs: this call's room and our per-call identity — so it can't be reused in another call. */
export function deviceStatementMessage(
  roomId: string,
  identityEd25519Pub: string,
): Uint8Array<ArrayBuffer> {
  return fields(DEVICE_LABEL, roomId, fromBase64Url(identityEd25519Pub));
}

export async function signDeviceStatement(
  deviceKey: DeviceKey,
  roomId: string,
  identityEd25519Pub: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.sign(
      'Ed25519',
      deviceKey.signing,
      deviceStatementMessage(roomId, identityEd25519Pub),
    ),
  );
}

/** Whether `devicePub` vouches for this per-call identity in this room. False for anything malformed. */
export function verifyDeviceStatement(
  devicePub: Uint8Array,
  roomId: string,
  identityEd25519Pub: string,
  sig: Uint8Array,
): Promise<boolean> {
  return verify(
    toBase64Url(devicePub),
    deviceStatementMessage(roomId, identityEd25519Pub),
    toBase64Url(sig),
  );
}
