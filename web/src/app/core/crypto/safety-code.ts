import { fields, fromBase64Url } from './encoding';

/**
 * The call's safety code: everyone in the call computes it from all participants' Ed25519 public keys (their own
 * included) and the room id, so everyone sees the same code only if everyone sees the same set of keys. A server that
 * injects a participant or swaps a key, or shows people different participant sets, changes someone's code.
 * Compared out loud — ~50 bits: 4 emoji (6 bits each) and 8 digits.
 */
export interface SafetyCode {
  emoji: { symbol: string; name: string }[];
  /** "1234 5678" */
  digits: string;
}

const LABEL = 'cipheroom/safety/v1';

/** `ed25519Pubs`: base64url, one per participant — duplicates count (a copied key still changes the code). */
export async function safetyCode(
  roomId: string,
  ed25519Pubs: readonly string[],
): Promise<SafetyCode> {
  const keys = [...ed25519Pubs].sort().map(fromBase64Url);
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', fields(LABEL, roomId, keys.length, ...keys)),
  );

  // First 3 bytes → four 6-bit emoji indexes.
  const bits = (hash[0] << 16) | (hash[1] << 8) | hash[2];
  const emoji = [18, 12, 6, 0].map((shift) => SAFETY_EMOJI[(bits >> shift) & 0x3f]);

  // Next 5 bytes (40 bits) → 8 digits (the modulo bias is far below anything audible).
  let n = 0;
  for (const b of hash.subarray(3, 8)) n = n * 256 + b;
  const digits = String(n % 100_000_000).padStart(8, '0');
  return {
    emoji: emoji.map(([symbol, name]) => ({ symbol, name })),
    digits: `${digits.slice(0, 4)} ${digits.slice(4)}`,
  };
}

/** 64 easy-to-name, visually distinct emoji. Order is part of the format — never reorder. */
// prettier-ignore
export const SAFETY_EMOJI: readonly (readonly [string, string])[] = [
  ['🐶', 'dog'], ['🐱', 'cat'], ['🦁', 'lion'], ['🐴', 'horse'],
  ['🦄', 'unicorn'], ['🐷', 'pig'], ['🐘', 'elephant'], ['🐰', 'rabbit'],
  ['🐼', 'panda'], ['🐓', 'rooster'], ['🐧', 'penguin'], ['🐢', 'turtle'],
  ['🐟', 'fish'], ['🐙', 'octopus'], ['🦋', 'butterfly'], ['🌷', 'tulip'],
  ['🌳', 'tree'], ['🌵', 'cactus'], ['🍄', 'mushroom'], ['🌍', 'globe'],
  ['🌙', 'moon'], ['☁️', 'cloud'], ['🔥', 'fire'], ['🍌', 'banana'],
  ['🍎', 'apple'], ['🍓', 'strawberry'], ['🌽', 'corn'], ['🍕', 'pizza'],
  ['🎂', 'cake'], ['❤️', 'heart'], ['😀', 'smiley'], ['🤖', 'robot'],
  ['🎩', 'hat'], ['👓', 'glasses'], ['🔧', 'wrench'], ['🎅', 'santa'],
  ['👍', 'thumbs up'], ['☂️', 'umbrella'], ['⌛', 'hourglass'], ['⏰', 'clock'],
  ['🎁', 'gift'], ['💡', 'light bulb'], ['📕', 'book'], ['✏️', 'pencil'],
  ['📎', 'paperclip'], ['✂️', 'scissors'], ['🔒', 'lock'], ['🔑', 'key'],
  ['🔨', 'hammer'], ['☎️', 'telephone'], ['🏁', 'flag'], ['🚂', 'train'],
  ['🚲', 'bicycle'], ['✈️', 'airplane'], ['🚀', 'rocket'], ['🏆', 'trophy'],
  ['⚽', 'ball'], ['🎸', 'guitar'], ['🎺', 'trumpet'], ['🔔', 'bell'],
  ['⚓', 'anchor'], ['🎧', 'headphones'], ['📁', 'folder'], ['📌', 'pin'],
];
