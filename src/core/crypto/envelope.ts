import { concatBytes, fromBase64, toBase64 } from '@utils/bytes';
import { CRYPTO_SIZES } from './types';

/**
 * Self-describing ciphertext envelope (replaces the legacy CryptoJS "Salted__"
 * AES-CBC format). Binary layout, then base64-encoded:
 *
 *   magic(2) | version(1) | salt(16) | nonce(24) | body(ciphertext+tag)
 *
 * `salt` feeds Argon2id; `nonce` feeds XChaCha20-Poly1305. The version byte lets
 * us rotate algorithms later without ambiguity.
 */
export const ENVELOPE_MAGIC = Uint8Array.from([0x42, 0x42]); // "BB"
export const ENVELOPE_VERSION = 0x01;

const HEADER_LEN = 2 + 1 + CRYPTO_SIZES.salt + CRYPTO_SIZES.nonce;

export interface EnvelopeParts {
  salt: Uint8Array;
  nonce: Uint8Array;
  body: Uint8Array;
}

export function encodeEnvelope(parts: EnvelopeParts): string {
  if (parts.salt.length !== CRYPTO_SIZES.salt) throw new Error('bad salt length');
  if (parts.nonce.length !== CRYPTO_SIZES.nonce) throw new Error('bad nonce length');
  const header = concatBytes(
    ENVELOPE_MAGIC,
    Uint8Array.from([ENVELOPE_VERSION]),
    parts.salt,
    parts.nonce,
  );
  return toBase64(concatBytes(header, parts.body));
}

export function decodeEnvelope(encoded: string): EnvelopeParts {
  const raw = fromBase64(encoded);
  if (raw.length < HEADER_LEN) throw new Error('envelope too short');
  if (raw[0] !== ENVELOPE_MAGIC[0] || raw[1] !== ENVELOPE_MAGIC[1]) {
    throw new Error('bad envelope magic');
  }
  const version = raw[2];
  if (version !== ENVELOPE_VERSION) throw new Error(`unsupported envelope version ${version}`);
  let offset = 3;
  const salt = raw.slice(offset, (offset += CRYPTO_SIZES.salt));
  const nonce = raw.slice(offset, (offset += CRYPTO_SIZES.nonce));
  const body = raw.slice(offset);
  return { salt, nonce, body };
}
