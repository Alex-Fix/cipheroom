import { fields, fromBase64Url, parseFields, toBase64Url, utf8 } from './encoding';
import { Identity, SIGNATURE_BYTES } from './identity';
import { KEYRING_SIZE, SENDER_KEY_BYTES } from './keyring';
import { sign, verify } from './statements';

/**
 * End-to-end encrypted chat (design: docs/plans/2026-10-09-encrypted-chat-design.md). Every event — a message or a
 * reaction, the server can't tell which — is signed by its author's per-call identity, padded to a size bucket and
 * encrypted with the author's chat key, which comes from the same sender key as their media key:
 *
 *   chatKey = HKDF-SHA-256(senderKey, salt = ∅, info = "cipheroom/chat/v1")  → AES-GCM-256, non-extractable
 *   sig     = Ed25519(identity, fields("cipheroom/chat-sig/v1", roomId, utf8(event JSON)))
 *   padded  = uint32 length ‖ fields(utf8(event JSON), sig) ‖ zeros   (to 512 / 2,048 / 8,192 / 16,384 bytes)
 *   aad     = fields("cipheroom/chat-aad/v1", roomId, fromId, keyIndex)
 *   blob    = base64url(version ‖ keyIndex ‖ iv (12 B, random) ‖ AES-GCM(chatKey, iv, aad, padded))
 */

export const MAX_CHAT_TEXT = 2000;
/** Largest blob we produce (16,384-byte bucket): the server's limit (ChatRules.MaxBlobLength) is a bit above. */
export const MAX_CHAT_BLOB = 21886;
export const PAD_BUCKETS = [512, 2048, 8192, 16384] as const;

const VERSION = 1;
const IV_BYTES = 12;
const HEADER_BYTES = 2 + IV_BYTES;
const CHAT_KEY_INFO = utf8('cipheroom/chat/v1');
const SIGNATURE_LABEL = 'cipheroom/chat-sig/v1';
const AAD_LABEL = 'cipheroom/chat-aad/v1';
const ID_BYTES = 16;
/** Longest emoji we accept as a reaction (ZWJ sequences included). */
const MAX_EMOJI_LENGTH = 32;

export type ChatEvent =
  | { v: 1; seq: number; type: 'message'; id: string; text: string }
  | { v: 1; seq: number; type: 'reaction'; target: string; emoji: string; on: boolean };

/** What CryptoService hands on: an event whose author signed it. */
export interface ReceivedChatEvent {
  fromId: string;
  /** The author's identity key (stable across their rejoins within the call). */
  authorPub: string;
  event: ChatEvent;
}

/** Why a chat blob was dropped: counted locally, never sent anywhere. */
export type ChatRejection =
  'malformed' | 'undecryptable' | 'bad-signature' | 'replayed' | 'unknown-sender' | 'no-key';

export class ChatError extends Error {
  constructor(readonly reason: ChatRejection) {
    super(`Chat event rejected: ${reason}.`);
  }
}

/** The AES-GCM key for chat under one sender key (derive before the sender key goes to the worker, which detaches it). */
export async function chatKey(
  senderKey: ArrayBuffer | Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  if (senderKey.byteLength !== SENDER_KEY_BYTES) throw new Error('Invalid sender key.');
  const material = await crypto.subtle.importKey('raw', senderKey, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: CHAT_KEY_INFO },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** A new message id: 16 random bytes (base64url). */
export const newChatId = (): string =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(ID_BYTES)));

/**
 * Chat text as it may be sent: trimmed, no control characters but newline and tab, no bidirectional overrides (they
 * can make a link or a name read differently than it is), at most MAX_CHAT_TEXT characters (code points).
 */
export function cleanChatText(text: string): string {
  const cleaned = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '')
    .trim();
  return [...cleaned].slice(0, MAX_CHAT_TEXT).join('');
}

export async function sealChat(
  context: { roomId: string; fromId: string; keyIndex: number; key: CryptoKey },
  event: ChatEvent,
  identity: Identity,
): Promise<string> {
  if (!isChatEvent(event)) throw new Error('Invalid chat event.');
  const json = utf8(JSON.stringify(event));
  const sig = fromBase64Url(await sign(identity, signedMessage(context.roomId, json)));
  const padded = pad(fields(json, sig));

  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: aad(context.roomId, context.fromId, context.keyIndex),
      },
      context.key,
      padded,
    ),
  );
  const out = new Uint8Array(HEADER_BYTES + ct.byteLength);
  out[0] = VERSION;
  out[1] = context.keyIndex;
  out.set(iv, 2);
  out.set(ct, HEADER_BYTES);
  return toBase64Url(out);
}

/** The key index a blob says it was encrypted under (to find the key). Throws ChatError('malformed'). */
export function chatKeyIndex(blob: string): number {
  return header(blob).keyIndex;
}

/**
 * Decrypts and checks one blob from `fromId`: the AES-GCM tag (room, sender and key index are bound), then the
 * author's signature, then the event's shape. Replays are the caller's job (sequence numbers per author).
 */
export async function openChat(
  blob: string,
  context: { roomId: string; fromId: string; key: CryptoKey },
  authorPub: string,
): Promise<ChatEvent> {
  const { keyIndex, bytes } = header(blob);
  let padded: Uint8Array;
  try {
    padded = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: bytes.slice(2, HEADER_BYTES),
          additionalData: aad(context.roomId, context.fromId, keyIndex),
        },
        context.key,
        bytes.slice(HEADER_BYTES),
      ),
    );
  } catch {
    throw new ChatError('undecryptable');
  }

  let json: Uint8Array<ArrayBuffer>;
  let sig: Uint8Array<ArrayBuffer>;
  try {
    const parts = parseFields(unpad(padded));
    if (parts.length !== 2 || parts[1].byteLength !== SIGNATURE_BYTES) throw new Error();
    [json, sig] = parts;
  } catch {
    throw new ChatError('malformed');
  }
  if (!(await verify(authorPub, signedMessage(context.roomId, json), toBase64Url(sig)))) {
    throw new ChatError('bad-signature');
  }

  let event: unknown;
  try {
    event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
  } catch {
    throw new ChatError('malformed');
  }
  if (!isChatEvent(event)) throw new ChatError('malformed');
  return event;
}

/** Exactly the shapes we send: no extra fields, ids of the right size, text as cleanChatText leaves it. */
export function isChatEvent(value: unknown): value is ChatEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  if (e['v'] !== VERSION || !isSeq(e['seq'])) return false;
  const keys = Object.keys(e).sort().join();
  if (e['type'] === 'message') {
    return (
      keys === 'id,seq,text,type,v' &&
      isId(e['id']) &&
      typeof e['text'] === 'string' &&
      e['text'].length > 0 &&
      cleanChatText(e['text']) === e['text']
    );
  }
  if (e['type'] === 'reaction') {
    return (
      keys === 'emoji,on,seq,target,type,v' &&
      isId(e['target']) &&
      typeof e['emoji'] === 'string' &&
      e['emoji'].length > 0 &&
      e['emoji'].length <= MAX_EMOJI_LENGTH &&
      typeof e['on'] === 'boolean'
    );
  }
  return false;
}

/** uint32 length ‖ content ‖ zeros, to the smallest bucket that fits. */
export function pad(content: Uint8Array): Uint8Array<ArrayBuffer> {
  const size = PAD_BUCKETS.find((b) => b >= content.byteLength + 4);
  if (!size) throw new Error('Chat event too large.');
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, content.byteLength);
  out.set(content, 4);
  return out;
}

/** Throws on anything pad couldn't have produced. */
export function unpad(padded: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(PAD_BUCKETS as readonly number[]).includes(padded.byteLength)) throw new Error('Bad size.');
  const length = new DataView(padded.buffer, padded.byteOffset, 4).getUint32(0);
  if (length > padded.byteLength - 4) throw new Error('Bad length.');
  if (padded.subarray(4 + length).some((b) => b !== 0)) throw new Error('Bad padding.');
  return padded.slice(4, 4 + length);
}

function header(blob: string): { keyIndex: number; bytes: Uint8Array<ArrayBuffer> } {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    if (blob.length > MAX_CHAT_BLOB) throw new Error();
    bytes = fromBase64Url(blob);
  } catch {
    throw new ChatError('malformed');
  }
  // Smallest valid blob: header + the 512-byte bucket + 16-byte tag.
  if (bytes.byteLength < HEADER_BYTES + PAD_BUCKETS[0] + 16) throw new ChatError('malformed');
  if (bytes[0] !== VERSION || bytes[1] >= KEYRING_SIZE) throw new ChatError('malformed');
  return { keyIndex: bytes[1], bytes };
}

const signedMessage = (roomId: string, json: Uint8Array) => fields(SIGNATURE_LABEL, roomId, json);
const aad = (roomId: string, fromId: string, keyIndex: number) =>
  fields(AAD_LABEL, roomId, fromId, keyIndex);
const isSeq = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER;

function isId(id: unknown): boolean {
  if (typeof id !== 'string') return false;
  try {
    return fromBase64Url(id).byteLength === ID_BYTES;
  } catch {
    return false;
  }
}
