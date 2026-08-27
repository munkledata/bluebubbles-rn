import { fromBase64, toBase64, utf8Decode, utf8Encode } from '@utils/bytes';
import { decodeEnvelope, encodeEnvelope } from './envelope';
import { ARGON2_INTERACTIVE, CRYPTO_SIZES, type CryptoBackend } from './types';

/**
 * Frozen BB2 backup-envelope contract. Never change these values or the nonce/AAD grammar in place:
 * a future format must use a new prefix/version so existing backups remain readable. BB2 uses 64 KiB
 * frames, a 16-byte AEAD tag, a random 20-byte nonce prefix plus a big-endian 32-bit frame counter,
 * and AAD formatted by `chunkAdditionalData`. Legacy v1 envelopes remain plain base64.
 */
export const CHUNKED_SECRET_BOX_PREFIX = 'BB2.';
export const CHUNKED_SECRET_BOX_CHUNK_BYTES = 64 * 1024;
export const SECRET_BOX_AEAD_TAG_BYTES = 16;

const NONCE_COUNTER_BYTES = 4;
const NONCE_PREFIX_BYTES = CRYPTO_SIZES.nonce - NONCE_COUNTER_BYTES;
const CHUNKED_HEADER_BYTES = CRYPTO_SIZES.salt + NONCE_PREFIX_BYTES + 4;
const CHUNKED_AAD_PREFIX = 'gator-secret-box-v2';
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES: Int16Array = (() => {
  const values = new Int16Array(128).fill(-1);
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    values[BASE64_ALPHABET.charCodeAt(index)] = index;
  }
  return values;
})();

export class SecretBoxPlaintextLimitError extends Error {
  constructor() {
    super('secret-box-plaintext-too-large');
    this.name = 'SecretBoxPlaintextLimitError';
  }
}

interface ChunkedFrameRange {
  start: number;
  end: number;
  plaintextBytes: number;
  index: number;
  final: boolean;
}

interface ParsedChunkedEnvelope {
  headerToken: string;
  salt: Uint8Array;
  noncePrefix: Uint8Array;
  plaintextBytes: number;
  frames: ChunkedFrameRange[];
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readUint32(source: Uint8Array, offset: number): number {
  return (
    source[offset]! * 0x1000000 +
    (source[offset + 1]! << 16) +
    (source[offset + 2]! << 8) +
    source[offset + 3]!
  );
}

function encodedBase64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** Reject ignored characters, misplaced padding, and non-zero unused padding bits. */
function isCanonicalBase64Token(token: string): boolean {
  if (token.length === 0 || token.length % 4 !== 0) return false;
  const padding = token.endsWith('==') ? 2 : token.endsWith('=') ? 1 : 0;
  const dataEnd = token.length - padding;
  for (let index = 0; index < dataEnd; index += 1) {
    const code = token.charCodeAt(index);
    if (code >= BASE64_VALUES.length || BASE64_VALUES[code] === -1) return false;
  }
  if (token.slice(dataEnd) !== '='.repeat(padding)) return false;
  if (padding === 2) return (BASE64_VALUES[token.charCodeAt(dataEnd - 1)]! & 0x0f) === 0;
  if (padding === 1) return (BASE64_VALUES[token.charCodeAt(dataEnd - 1)]! & 0x03) === 0;
  return true;
}

function decodeCanonicalBase64(token: string, expectedBytes: number): Uint8Array {
  if (!isCanonicalBase64TokenForBytes(token, expectedBytes)) {
    throw new Error('malformed chunked envelope base64');
  }
  const decoded = fromBase64(token);
  if (decoded.length !== expectedBytes) throw new Error('malformed chunked envelope length');
  return decoded;
}

function isCanonicalBase64TokenForBytes(token: string, expectedBytes: number): boolean {
  if (!isCanonicalBase64Token(token) || token.length !== encodedBase64Length(expectedBytes)) {
    return false;
  }
  const expectedPadding = expectedBytes % 3 === 0 ? 0 : expectedBytes % 3 === 1 ? 2 : 1;
  const actualPadding = token.endsWith('==') ? 2 : token.endsWith('=') ? 1 : 0;
  return actualPadding === expectedPadding;
}

/** Hermes-portable strict UTF-8 validation: replacement decoding cannot round-trip bad bytes. */
function decodeStrictUtf8(bytes: Uint8Array): string {
  const decoded = utf8Decode(bytes);
  const roundTrip = utf8Encode(decoded);
  if (
    roundTrip.length !== bytes.length ||
    roundTrip.some((value, index) => value !== bytes[index])
  ) {
    throw new Error('secret box plaintext is not valid UTF-8');
  }
  return decoded;
}

function chunkNonce(prefix: Uint8Array, index: number): Uint8Array {
  const nonce = new Uint8Array(CRYPTO_SIZES.nonce);
  nonce.set(prefix);
  writeUint32(nonce, NONCE_PREFIX_BYTES, index);
  return nonce;
}

function chunkAdditionalData(headerToken: string, index: number, final: boolean): string {
  return `${CHUNKED_AAD_PREFIX}|${headerToken}|${index}|${final ? 'final' : 'message'}`;
}

function parseChunkedEnvelope(encoded: string, maxPlaintextBytes: number): ParsedChunkedEnvelope {
  if (!Number.isSafeInteger(maxPlaintextBytes) || maxPlaintextBytes < 0) {
    throw new Error('invalid chunked plaintext limit');
  }
  if (!encoded.startsWith(CHUNKED_SECRET_BOX_PREFIX)) {
    throw new Error('bad chunked envelope magic');
  }

  const headerStart = CHUNKED_SECRET_BOX_PREFIX.length;
  const headerEnd = headerStart + encodedBase64Length(CHUNKED_HEADER_BYTES);
  if (encoded.charAt(headerEnd) !== '.') throw new Error('malformed chunked envelope header');
  const headerToken = encoded.slice(0, headerEnd);
  const header = decodeCanonicalBase64(encoded.slice(headerStart, headerEnd), CHUNKED_HEADER_BYTES);
  const plaintextBytes = readUint32(header, CHUNKED_HEADER_BYTES - 4);
  if (plaintextBytes > maxPlaintextBytes) throw new SecretBoxPlaintextLimitError();

  const frameCount = Math.max(1, Math.ceil(plaintextBytes / CHUNKED_SECRET_BOX_CHUNK_BYTES));
  const frames: ChunkedFrameRange[] = [];
  let cursor = headerEnd + 1;
  for (let index = 0; index < frameCount; index += 1) {
    const final = index === frameCount - 1;
    const nextSeparator = encoded.indexOf('.', cursor);
    if (!final && nextSeparator < 0) throw new Error('truncated chunked envelope');
    if (final && nextSeparator >= 0) throw new Error('extra chunked envelope frame');
    const end = final ? encoded.length : nextSeparator;
    const remaining = plaintextBytes - index * CHUNKED_SECRET_BOX_CHUNK_BYTES;
    const framePlaintextBytes = Math.max(0, Math.min(CHUNKED_SECRET_BOX_CHUNK_BYTES, remaining));
    const token = encoded.slice(cursor, end);
    if (!isCanonicalBase64TokenForBytes(token, framePlaintextBytes + SECRET_BOX_AEAD_TAG_BYTES)) {
      throw new Error('malformed chunked envelope frame');
    }
    frames.push({ start: cursor, end, plaintextBytes: framePlaintextBytes, index, final });
    cursor = end + 1;
  }

  return {
    headerToken,
    salt: header.slice(0, CRYPTO_SIZES.salt),
    noncePrefix: header.slice(CRYPTO_SIZES.salt, CHUNKED_HEADER_BYTES - 4),
    plaintextBytes,
    frames,
  };
}

export function isChunkedSecretBoxEnvelope(encoded: string): boolean {
  return encoded.startsWith(CHUNKED_SECRET_BOX_PREFIX);
}

/**
 * Passphrase-based authenticated encryption for strings.
 *
 * Each `seal()` generates a fresh random salt + nonce, derives a key with
 * Argon2id, and encrypts with XChaCha20-Poly1305. `open()` reverses it and will
 * throw if the ciphertext was tampered with (authenticated decryption) — closing
 * the padding-oracle / tamper gap in the legacy AES-CBC implementation.
 *
 * Use for at-rest secrets (e.g. wrapping the SQLCipher DB key) and, where the
 * server supports the matching scheme, socket payloads.
 */
export class SecretBox {
  constructor(
    private readonly backend: CryptoBackend,
    private readonly argon2: { opsLimit: number; memLimit: number } = ARGON2_INTERACTIVE,
  ) {}

  async seal(plaintext: string, passphrase: string): Promise<string> {
    const salt = await this.backend.randomBytes(CRYPTO_SIZES.salt);
    const nonce = await this.backend.randomBytes(CRYPTO_SIZES.nonce);
    const key = await this.deriveKey(passphrase, salt);
    try {
      const body = await this.backend.aeadEncrypt({
        plaintext: utf8Encode(plaintext),
        key,
        nonce,
      });
      return encodeEnvelope({ salt, nonce, body });
    } finally {
      key.fill(0);
    }
  }

  async open(encoded: string, passphrase: string): Promise<string> {
    const { salt, nonce, body } = decodeEnvelope(encoded);
    if (body.length < SECRET_BOX_AEAD_TAG_BYTES) throw new Error('envelope body too short');
    return this.openDecoded(salt, nonce, body, passphrase);
  }

  /** Bound a legacy v1 body before Argon2 or the native AEAD bridge sees it. */
  async openBounded(
    encoded: string,
    passphrase: string,
    maxPlaintextBytes: number,
  ): Promise<string> {
    if (!Number.isSafeInteger(maxPlaintextBytes) || maxPlaintextBytes < 0) {
      throw new Error('invalid secret box plaintext limit');
    }
    if (!isCanonicalBase64Token(encoded)) {
      throw new Error('malformed legacy secret box envelope base64');
    }
    const { salt, nonce, body } = decodeEnvelope(encoded);
    if (body.length < SECRET_BOX_AEAD_TAG_BYTES) throw new Error('envelope body too short');
    if (body.length > maxPlaintextBytes + SECRET_BOX_AEAD_TAG_BYTES) {
      throw new SecretBoxPlaintextLimitError();
    }
    return this.openDecoded(salt, nonce, body, passphrase);
  }

  /**
   * Seal a string as independently authenticated chunks.
   *
   * The random 160-bit nonce prefix plus a 32-bit frame counter gives every frame a unique
   * XChaCha20 nonce under the derived key. The exact header, frame index, and final marker are AAD,
   * so frames cannot be reordered, removed, appended, or moved between envelopes.
   */
  async sealChunked(plaintext: string, passphrase: string): Promise<string> {
    const plaintextBytes = utf8Encode(plaintext);
    if (plaintextBytes.length > 0xffffffff) throw new Error('chunked plaintext too large');

    const salt = await this.backend.randomBytes(CRYPTO_SIZES.salt);
    const noncePrefix = await this.backend.randomBytes(NONCE_PREFIX_BYTES);
    if (salt.length !== CRYPTO_SIZES.salt || noncePrefix.length !== NONCE_PREFIX_BYTES) {
      throw new Error('chunked encryption returned invalid random bytes');
    }
    const header = new Uint8Array(CHUNKED_HEADER_BYTES);
    header.set(salt);
    header.set(noncePrefix, CRYPTO_SIZES.salt);
    writeUint32(header, CHUNKED_HEADER_BYTES - 4, plaintextBytes.length);
    const headerToken = `${CHUNKED_SECRET_BOX_PREFIX}${toBase64(header)}`;
    const key = await this.deriveKey(passphrase, salt);
    try {
      const frameCount = Math.max(
        1,
        Math.ceil(plaintextBytes.length / CHUNKED_SECRET_BOX_CHUNK_BYTES),
      );
      const tokens = [headerToken];
      for (let index = 0; index < frameCount; index += 1) {
        const final = index === frameCount - 1;
        const start = index * CHUNKED_SECRET_BOX_CHUNK_BYTES;
        const chunk = plaintextBytes.slice(start, start + CHUNKED_SECRET_BOX_CHUNK_BYTES);
        const ciphertext = await this.backend.aeadEncrypt({
          plaintext: chunk,
          key,
          nonce: chunkNonce(noncePrefix, index),
          additionalData: chunkAdditionalData(headerToken, index, final),
        });
        if (ciphertext.length !== chunk.length + SECRET_BOX_AEAD_TAG_BYTES) {
          throw new Error('chunked encryption returned an invalid length');
        }
        tokens.push(toBase64(ciphertext));
      }
      return tokens.join('.');
    } finally {
      key.fill(0);
    }
  }

  /**
   * Strictly preflight, then decode and authenticate one bounded frame at a time.
   *
   * Only the final plaintext buffer is sized to the authenticated header's already-capped length;
   * no whole-envelope ciphertext buffer is created. Legacy v1 import remains in `open()`.
   */
  async openChunked(
    encoded: string,
    passphrase: string,
    maxPlaintextBytes: number,
  ): Promise<string> {
    const parsed = parseChunkedEnvelope(encoded, maxPlaintextBytes);
    const key = await this.deriveKey(passphrase, parsed.salt);
    try {
      const plaintext = new Uint8Array(parsed.plaintextBytes);
      let offset = 0;
      for (const frame of parsed.frames) {
        const ciphertext = decodeCanonicalBase64(
          encoded.slice(frame.start, frame.end),
          frame.plaintextBytes + SECRET_BOX_AEAD_TAG_BYTES,
        );
        const chunk = await this.backend.aeadDecrypt({
          ciphertext,
          key,
          nonce: chunkNonce(parsed.noncePrefix, frame.index),
          additionalData: chunkAdditionalData(parsed.headerToken, frame.index, frame.final),
        });
        if (chunk.length !== frame.plaintextBytes) {
          throw new Error('chunked decryption returned an invalid length');
        }
        plaintext.set(chunk, offset);
        offset += chunk.length;
      }
      if (offset !== plaintext.length) throw new Error('incomplete chunked plaintext');
      return decodeStrictUtf8(plaintext);
    } finally {
      key.fill(0);
    }
  }

  private async openDecoded(
    salt: Uint8Array,
    nonce: Uint8Array,
    body: Uint8Array,
    passphrase: string,
  ): Promise<string> {
    const key = await this.deriveKey(passphrase, salt);
    try {
      const plaintext = await this.backend.aeadDecrypt({ ciphertext: body, key, nonce });
      return decodeStrictUtf8(plaintext);
    } finally {
      key.fill(0);
    }
  }

  private deriveKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
    return this.backend.deriveKey({
      passphrase,
      salt,
      keyLength: CRYPTO_SIZES.key,
      opsLimit: this.argon2.opsLimit,
      memLimit: this.argon2.memLimit,
    });
  }
}
