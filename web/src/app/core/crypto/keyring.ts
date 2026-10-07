/**
 * Media keys of one call, held by the frame-crypto worker: our own send key and every remote participant's keys by
 * key index. Each 32-byte sender key becomes a non-extractable AES-GCM-256 media key via
 * HKDF-SHA-256(info "cipheroom/media/v1"); the raw bytes are never kept.
 *
 * A new key for a participant doesn't drop the older ones at once: frames still in flight (and frames sent before
 * the sender switched over) keep decrypting for PREVIOUS_KEY_GRACE_MS.
 */
export const KEYRING_SIZE = 16;
export const SENDER_KEY_BYTES = 32;
export const PREVIOUS_KEY_GRACE_MS = 10_000;

interface ReceiveKey {
  key: CryptoKey;
  /** Set once a newer key for the same participant arrived. */
  expiresAt?: number;
}

export interface SendKey {
  key: CryptoKey;
  keyIndex: number;
  counter: bigint;
}

export class Keyring {
  private send?: { key: CryptoKey; keyIndex: number; counter: bigint };
  private readonly receive = new Map<string, Map<number, ReceiveKey>>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Switches our own encryption to this key; its IV counter starts at 0 (a new key is a new IV space). */
  async setSendKey(keyIndex: number, senderKey: ArrayBuffer): Promise<void> {
    const key = await mediaKey(keyIndex, senderKey, 'encrypt');
    this.send = { key, keyIndex, counter: 0n };
  }

  /** The key for our next frame, with a counter never used before under that key. */
  nextSend(): SendKey | undefined {
    if (!this.send) return undefined;
    return { key: this.send.key, keyIndex: this.send.keyIndex, counter: this.send.counter++ };
  }

  async setReceiveKey(
    participantId: string,
    keyIndex: number,
    senderKey: ArrayBuffer,
  ): Promise<void> {
    const key = await mediaKey(keyIndex, senderKey, 'decrypt');
    const keys = this.receive.get(participantId) ?? new Map<number, ReceiveKey>();
    const expiresAt = this.now() + PREVIOUS_KEY_GRACE_MS;
    for (const [index, entry] of keys) if (index !== keyIndex) entry.expiresAt ??= expiresAt;
    keys.set(keyIndex, { key });
    this.receive.set(participantId, keys);
  }

  receiveKey(participantId: string, keyIndex: number): CryptoKey | undefined {
    const keys = this.receive.get(participantId);
    const entry = keys?.get(keyIndex);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      keys!.delete(keyIndex);
      return undefined;
    }
    return entry.key;
  }

  removeParticipant(participantId: string): void {
    this.receive.delete(participantId);
  }
}

async function mediaKey(
  keyIndex: number,
  senderKey: ArrayBuffer,
  usage: KeyUsage,
): Promise<CryptoKey> {
  if (!Number.isInteger(keyIndex) || keyIndex < 0 || keyIndex >= KEYRING_SIZE) {
    throw new Error('Invalid key index.');
  }
  if (senderKey.byteLength !== SENDER_KEY_BYTES) throw new Error('Invalid sender key.');
  const material = await crypto.subtle.importKey('raw', senderKey, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: MEDIA_KEY_INFO },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

const MEDIA_KEY_INFO = new TextEncoder().encode('cipheroom/media/v1');
