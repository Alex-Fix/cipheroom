import { fields, fromBase64Url, toBase64Url, utf8 } from './encoding';
import { Identity, PUBLIC_KEY_BYTES, SIGNATURE_BYTES, VerifiedIdentity } from './identity';
import { KEYRING_SIZE, SENDER_KEY_BYTES } from './keyring';

/**
 * Sender-key envelopes (v1): how a participant's sender key reaches one other participant through the untrusted
 * server. Design: docs/plans/2026-10-07-e2ee-media-design.md → "Sender keys and envelopes".
 *
 *   header = { v: 1, roomId, epoch, keyIndex, fromId, toId }
 *   k   = HKDF-SHA-256(X25519(ephemeral, recipient), salt = roomId, info = "cipheroom/env/v1")
 *   aad = fields("cipheroom/env-header/v1", roomId, epoch, keyIndex, fromId, toId)   (see encoding.ts)
 *   ct  = AES-GCM(k, iv = random 12 B, aad, senderKey)
 *   sig = Ed25519(sender identity, fields("cipheroom/env-sig/v1", aad, ephPub, iv, ct))
 *   blob = base64url(JSON { ...header, eph, iv, ct, sig })      — opaque to the server
 */
export interface EnvelopeHeader {
  roomId: string;
  /** Sender's rotation counter: strictly increasing per sender. */
  epoch: number;
  /** `epoch mod KEYRING_SIZE`; carried in every frame encrypted under this key. */
  keyIndex: number;
  fromId: string;
  toId: string;
}

export interface OpenedEnvelope {
  epoch: number;
  keyIndex: number;
  /** 32 bytes — hand straight to FrameCrypto, which transfers (detaches) it. */
  senderKey: ArrayBuffer;
}

/** Why an envelope was rejected: counted locally, never sent anywhere. */
export type EnvelopeRejection =
  | 'malformed'
  | 'bad-signature'
  | 'wrong-room'
  | 'wrong-sender'
  | 'wrong-recipient'
  | 'stale-epoch'
  | 'undecryptable';

export class EnvelopeError extends Error {
  constructor(readonly reason: EnvelopeRejection) {
    super(`Envelope rejected: ${reason}.`);
  }
}

/** Largest blob the server relays (base64url characters). */
export const MAX_ENVELOPE_BLOB = 1024;
const VERSION = 1;
const ENVELOPE_INFO = utf8('cipheroom/env/v1');
/** Domain separation: the identity key also signs the bundle ("cipheroom/id/v1"). */
const HEADER_LABEL = 'cipheroom/env-header/v1';
const SIGNATURE_LABEL = 'cipheroom/env-sig/v1';
const IV_BYTES = 12;
const MAX_EPOCH = 0xffff_ffff;

interface WireEnvelope {
  v: number;
  roomId: string;
  epoch: number;
  keyIndex: number;
  fromId: string;
  toId: string;
  eph: string;
  iv: string;
  ct: string;
  sig: string;
}

export async function sealEnvelope(
  header: EnvelopeHeader,
  senderKey: Uint8Array<ArrayBuffer>,
  sender: Identity,
  recipient: VerifiedIdentity,
): Promise<string> {
  if (senderKey.byteLength !== SENDER_KEY_BYTES) throw new Error('Invalid sender key.');
  if (!validIndex(header.epoch, header.keyIndex)) throw new Error('Invalid key index.');

  const ephemeral = (await crypto.subtle.generateKey('X25519', false, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const eph = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const key = await wrappingKey(ephemeral.privateKey, recipient.agreement, header.roomId, [
    'encrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: headerFields(header) },
      key,
      senderKey,
    ),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('Ed25519', sender.signing.privateKey, signedPart(header, eph, iv, ct)),
  );

  const wire: WireEnvelope = {
    v: VERSION,
    ...pickHeader(header),
    eph: toBase64Url(eph),
    iv: toBase64Url(iv),
    ct: toBase64Url(ct),
    sig: toBase64Url(sig),
  };
  return toBase64Url(utf8(JSON.stringify(wire)));
}

/**
 * Verifies and decrypts an envelope relayed by the server. `fromId` is who the server says sent it; `sender` is that
 * participant's identity as shown in the call; `lastEpoch` the newest epoch already accepted from them.
 * Throws EnvelopeError — nothing in a rejected envelope is used.
 */
export async function openEnvelope(
  blob: string,
  expected: { roomId: string; selfId: string; fromId: string; lastEpoch?: number },
  self: Identity,
  sender: VerifiedIdentity,
): Promise<OpenedEnvelope> {
  const wire = parse(blob);
  const header = pickHeader(wire);
  let eph: Uint8Array<ArrayBuffer>, iv: Uint8Array<ArrayBuffer>, ct: Uint8Array<ArrayBuffer>;
  let sig: Uint8Array<ArrayBuffer>;
  try {
    [eph, iv, ct, sig] = [wire.eph, wire.iv, wire.ct, wire.sig].map(fromBase64Url);
  } catch {
    throw new EnvelopeError('malformed');
  }
  if (
    eph.byteLength !== PUBLIC_KEY_BYTES ||
    iv.byteLength !== IV_BYTES ||
    sig.byteLength !== SIGNATURE_BYTES
  ) {
    throw new EnvelopeError('malformed');
  }

  // Signature first: nothing unauthenticated is looked at further.
  const signed = await crypto.subtle
    .verify('Ed25519', sender.signing, sig, signedPart(header, eph, iv, ct))
    .catch(() => false);
  if (!signed) throw new EnvelopeError('bad-signature');
  if (header.roomId !== expected.roomId) throw new EnvelopeError('wrong-room');
  if (header.fromId !== expected.fromId) throw new EnvelopeError('wrong-sender');
  if (header.toId !== expected.selfId) throw new EnvelopeError('wrong-recipient');
  if (expected.lastEpoch !== undefined && header.epoch <= expected.lastEpoch) {
    throw new EnvelopeError('stale-epoch');
  }

  try {
    const ephKey = await crypto.subtle.importKey('raw', eph, 'X25519', false, []);
    const key = await wrappingKey(self.agreement.privateKey, ephKey, header.roomId, ['decrypt']);
    const senderKey = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: headerFields(header) },
      key,
      ct,
    );
    if (senderKey.byteLength !== SENDER_KEY_BYTES) throw new Error('Invalid sender key.');
    return { epoch: header.epoch, keyIndex: header.keyIndex, senderKey };
  } catch {
    throw new EnvelopeError('undecryptable');
  }
}

/** Key index for an epoch: what senders put in the header and every frame. */
export const keyIndexOf = (epoch: number): number => epoch % KEYRING_SIZE;

async function wrappingKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  roomId: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits(
    { name: 'X25519', public: publicKey },
    privateKey,
    256,
  );
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(roomId), info: ENVELOPE_INFO },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}

function headerFields(h: EnvelopeHeader): Uint8Array<ArrayBuffer> {
  return fields(HEADER_LABEL, h.roomId, h.epoch, h.keyIndex, h.fromId, h.toId);
}

function signedPart(
  h: EnvelopeHeader,
  eph: Uint8Array,
  iv: Uint8Array,
  ct: Uint8Array,
): Uint8Array<ArrayBuffer> {
  return fields(SIGNATURE_LABEL, headerFields(h), eph, iv, ct);
}

function pickHeader({ roomId, epoch, keyIndex, fromId, toId }: EnvelopeHeader): EnvelopeHeader {
  return { roomId, epoch, keyIndex, fromId, toId };
}

function validIndex(epoch: number, keyIndex: number): boolean {
  return (
    Number.isInteger(epoch) && epoch >= 0 && epoch <= MAX_EPOCH && keyIndex === keyIndexOf(epoch)
  );
}

function parse(blob: string): WireEnvelope {
  try {
    if (blob.length > MAX_ENVELOPE_BLOB) throw new Error('Too long.');
    const wire = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(blob)));
    const strings = ['roomId', 'fromId', 'toId', 'eph', 'iv', 'ct', 'sig'] as const;
    if (
      typeof wire !== 'object' ||
      wire === null ||
      wire.v !== VERSION ||
      !strings.every((k) => typeof wire[k] === 'string') ||
      !validIndex(wire.epoch, wire.keyIndex)
    ) {
      throw new Error('Bad shape.');
    }
    return wire as WireEnvelope;
  } catch {
    throw new EnvelopeError('malformed');
  }
}
