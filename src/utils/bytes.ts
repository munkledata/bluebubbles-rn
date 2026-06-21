/**
 * Pure-TypeScript byte helpers (base64, concat, constant-time compare).
 *
 * Implemented without Node's Buffer or `btoa`/`atob` so they work identically in
 * Node (tests) and the React Native JS runtime (no polyfill required).
 */

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP: Int8Array = (() => {
  const table = new Int8Array(256).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) table[B64_CHARS.charCodeAt(i)] = i;
  return table;
})();

export function toBase64(bytes: Uint8Array): string {
  // charAt returns a string (never undefined), satisfying noUncheckedIndexedAccess.
  const c = (idx: number): string => B64_CHARS.charAt(idx & 63);
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += c(n >> 18) + c(n >> 12) + c(n >> 6) + c(n);
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += c(n >> 18) + c(n >> 12) + '==';
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += c(n >> 18) + c(n >> 12) + c(n >> 6) + '=';
  }
  return out;
}

export function fromBase64(input: string): Uint8Array {
  const str = input.replace(/[^A-Za-z0-9+/]/g, '');
  const len = str.length;
  const outLen = Math.floor((len * 3) / 4);
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const c0 = B64_LOOKUP[str.charCodeAt(i)]!;
    const c1 = B64_LOOKUP[str.charCodeAt(i + 1)]!;
    const c2 = i + 2 < len ? B64_LOOKUP[str.charCodeAt(i + 2)]! : -1;
    const c3 = i + 3 < len ? B64_LOOKUP[str.charCodeAt(i + 3)]! : -1;
    const n = (c0 << 18) | (c1 << 12) | ((c2 & 63) << 6) | (c3 & 63);
    if (o < outLen) out[o++] = (n >> 16) & 0xff;
    if (c2 !== -1 && o < outLen) out[o++] = (n >> 8) & 0xff;
    if (c3 !== -1 && o < outLen) out[o++] = n & 0xff;
  }
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function utf8Encode(s: string): Uint8Array {
  // TextEncoder is available in Node and the Hermes/RN runtime.
  return new TextEncoder().encode(s);
}

export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Constant-time equality to avoid timing leaks on token/MAC comparisons. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
