import { fields, fromBase64Url, toBase32, toBase64Url } from './encoding';

/**
 * A meeting's host key, held in the creator's browser (design: docs/plans/2026-10-08-lobby-admission-design.md):
 * Ed25519 for signing host attestations and X25519 (kept for later use, and part of the room id). The room id is a
 * hash of both public keys, so the invite link itself says who the host is — nobody, the server included, can
 * claim the room without these private keys. Private keys are non-extractable once stored.
 */
export interface HostKey {
  roomId: string;
  signing: CryptoKey;
  agreement: CryptoKey;
  ed25519Pub: string;
  x25519Pub: string;
  createdAt: number;
}

/** The private keys as PKCS#8, only right after creation (for the one-time backup) or while importing one. */
export interface HostKeyMaterial {
  ed25519Pkcs8: Uint8Array<ArrayBuffer>;
  x25519Pkcs8: Uint8Array<ArrayBuffer>;
}

export const ROOM_ID_LENGTH = 26;
export const ROOM_ID_PATTERN = /^[a-z2-7]{26}$/;
const ROOM_LABEL = 'cipheroom/room/v1';
const HOST_LABEL = 'cipheroom/host/v1';

/** base32(SHA-256(fields(label, ed25519Pub, x25519Pub))), first 26 characters (130 bits). Same as the api's. */
export async function deriveRoomId(ed25519Pub: Uint8Array, x25519Pub: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', fields(ROOM_LABEL, ed25519Pub, x25519Pub));
  return toBase32(new Uint8Array(hash)).slice(0, ROOM_ID_LENGTH);
}

/**
 * A new meeting: fresh host keys, stored non-extractable. `material` is the only exportable copy of the private
 * keys — use it for the backup right away, then call `wipe(material)`.
 */
export async function createHostKey(
  now = Date.now(),
): Promise<{ hostKey: HostKey; material: HostKeyMaterial }> {
  const signing = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const agreement = (await crypto.subtle.generateKey('X25519', true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const material: HostKeyMaterial = {
    ed25519Pkcs8: new Uint8Array(await crypto.subtle.exportKey('pkcs8', signing.privateKey)),
    x25519Pkcs8: new Uint8Array(await crypto.subtle.exportKey('pkcs8', agreement.privateKey)),
  };
  return { hostKey: await hostKeyFrom(material, now), material };
}

/** Imports private keys (from a backup) as a non-extractable host key; its room id follows from the public keys. */
export async function hostKeyFrom(material: HostKeyMaterial, now = Date.now()): Promise<HostKey> {
  const ed25519Pub = await publicKeyOf(material.ed25519Pkcs8, 'Ed25519', ['sign']);
  const x25519Pub = await publicKeyOf(material.x25519Pkcs8, 'X25519', ['deriveBits']);
  return {
    roomId: await deriveRoomId(ed25519Pub, x25519Pub),
    signing: await crypto.subtle.importKey('pkcs8', material.ed25519Pkcs8, 'Ed25519', false, [
      'sign',
    ]),
    agreement: await crypto.subtle.importKey('pkcs8', material.x25519Pkcs8, 'X25519', false, [
      'deriveBits',
    ]),
    ed25519Pub: toBase64Url(ed25519Pub),
    x25519Pub: toBase64Url(x25519Pub),
    createdAt: now,
  };
}

/** Overwrites the exportable copy of the private keys. */
export function wipe(material: HostKeyMaterial): void {
  material.ed25519Pkcs8.fill(0);
  material.x25519Pkcs8.fill(0);
}

/** The host key's signature over our per-call identity: how the host's browser proves it is the host. */
export async function signHostAttestation(
  hostKey: HostKey,
  identityEd25519Pub: string,
): Promise<string> {
  const message = hostAttestationMessage(hostKey.roomId, identityEd25519Pub);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('Ed25519', hostKey.signing, message)));
}

export function hostAttestationMessage(
  roomId: string,
  identityEd25519Pub: string,
): Uint8Array<ArrayBuffer> {
  return fields(HOST_LABEL, roomId, fromBase64Url(identityEd25519Pub));
}

/** The public key of a PKCS#8 private key (via a short-lived extractable import that is never stored). */
async function publicKeyOf(
  pkcs8: Uint8Array<ArrayBuffer>,
  algorithm: 'Ed25519' | 'X25519',
  usages: KeyUsage[],
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, algorithm, true, usages);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  if (!jwk.x) throw new Error('No public key.');
  const pub = fromBase64Url(jwk.x);
  if (pub.byteLength !== 32) throw new Error('Bad public key.');
  return pub;
}
