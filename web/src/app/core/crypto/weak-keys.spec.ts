import { fromBase64Url } from './encoding';
import { createIdentity } from './identity';
import { isWeakEd25519Key } from './weak-keys';

const P = (1n << 255n) - 19n;
const le = (n: bigint) => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++, n >>= 8n) out[i] = Number(n & 0xffn);
  return out;
};
const pow = (b: bigint, e: bigint) => {
  let r = 1n;
  for (b %= P; e > 0n; e >>= 1n, b = (b * b) % P) if (e & 1n) r = (r * b) % P;
  return r;
};
/** The Edwards y of an X25519 u: y = (u − 1) / (u + 1). */
const edwardsY = (u: bigint) => (((u - 1n + P) % P) * pow((u + 1n) % P, P - 2n)) % P;

describe('isWeakEd25519Key', () => {
  it('accepts real keys', async () => {
    for (let i = 0; i < 5; i++) {
      const { bundle } = await createIdentity('room');
      expect(await isWeakEd25519Key(fromBase64Url(bundle.ed25519Pub))).toBe(false);
    }
  });

  it('rejects the small-order points', async () => {
    expect(await isWeakEd25519Key(new Uint8Array(32))).toBe(true); // y = 0, order 4
    expect(await isWeakEd25519Key(le(1n))).toBe(true); // the neutral point
    expect(await isWeakEd25519Key(le(P - 1n))).toBe(true); // y = −1, order 2
    // The order-8 points, from the published X25519 small-order u values (cr.yp.to/ecdh.html).
    for (const u of [
      325606250916557431795983626356110631294008115727848805560023387167927233504n,
      39382357235489614581723060781553021112529911719440698176882885853963445705823n,
    ]) {
      expect(await isWeakEd25519Key(le(edwardsY(u)))).toBe(true);
    }
  });

  it('rejects non-canonical encodings and wrong sizes', async () => {
    expect(await isWeakEd25519Key(le(P + 1n))).toBe(true);
    expect(await isWeakEd25519Key(new Uint8Array(31))).toBe(true);
  });
});
