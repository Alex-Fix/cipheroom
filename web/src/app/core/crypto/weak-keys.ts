/**
 * Rejects Ed25519 public keys of small order (and non-canonical encodings). For such a "key" trivial signatures can
 * verify for many messages without anyone holding a private key — e.g. the all-zero key with an all-zero signature —
 * so several people could present the same "identity". WebCrypto has no such check for Ed25519, so we map the point
 * to its X25519 (Montgomery) form, u = (1 + y) / (1 − y), and let one X25519 agreement decide: WebCrypto must refuse
 * the all-zero result that a small-order point gives (RFC 7748 §6.1, WebCrypto X25519 deriveBits).
 */
const P = (1n << 255n) - 19n;
const cache = new Map<string, Promise<boolean>>();

export function isWeakEd25519Key(pub: Uint8Array): Promise<boolean> {
  if (pub.byteLength !== 32) return Promise.resolve(true);
  const id = Array.from(pub, (b) => b.toString(16).padStart(2, '0')).join('');
  let result = cache.get(id);
  if (!result) {
    result = check(pub).catch(() => true);
    cache.set(id, result);
  }
  return result;
}

async function check(pub: Uint8Array): Promise<boolean> {
  const bytes = pub.slice();
  bytes[31] &= 0x7f; // the sign of x doesn't change the order
  const y = fromLittleEndian(bytes);
  if (y >= P) return true; // non-canonical
  if (y === 1n) return true; // the neutral point
  const u = mod((1n + y) * inverse(mod(1n - y)));
  const point = await crypto.subtle.importKey('raw', toLittleEndian(u), 'X25519', false, []);
  const own = (await crypto.subtle.generateKey('X25519', false, ['deriveBits'])) as CryptoKeyPair;
  try {
    await crypto.subtle.deriveBits({ name: 'X25519', public: point }, own.privateKey, 256);
    return false;
  } catch {
    return true;
  }
}

const mod = (n: bigint) => ((n % P) + P) % P;

function inverse(n: bigint): bigint {
  // Fermat: n^(p−2) mod p.
  let result = 1n;
  let base = n;
  let exp = P - 2n;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % P;
    base = (base * base) % P;
    exp >>= 1n;
  }
  return result;
}

function fromLittleEndian(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

function toLittleEndian(n: bigint): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}
