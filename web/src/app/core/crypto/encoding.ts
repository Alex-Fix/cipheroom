/** Byte helpers for the key-management code: base64url for the wire, length-prefixed fields for anything signed. */

const encoder = new TextEncoder();

export const utf8 = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(text);

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Throws on anything that isn't unpadded base64url. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error('Not base64url.');
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Unambiguous encoding of a list of fields for signatures, AAD and hashes: each field as a 4-byte big-endian length
 * followed by its bytes (strings as UTF-8, numbers as 4-byte big-endian unsigned integers). Fields carry no type,
 * so every use has a fixed field order and types, starting with its own label.
 */
export function fields(...parts: (string | number | Uint8Array)[]): Uint8Array<ArrayBuffer> {
  const encoded = parts.map((p) => {
    if (typeof p === 'string') return utf8(p);
    if (typeof p === 'number') {
      const n = new Uint8Array(4);
      new DataView(n.buffer).setUint32(0, p);
      return n;
    }
    return p;
  });
  const out = new Uint8Array(encoded.reduce((n, p) => n + 4 + p.byteLength, 0));
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const p of encoded) {
    view.setUint32(offset, p.byteLength);
    out.set(p, offset + 4);
    offset += 4 + p.byteLength;
  }
  return out;
}
