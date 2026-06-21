import { utf8Decode, utf8Encode } from '@utils/bytes';
import { decodeEnvelope, encodeEnvelope } from './envelope';
import { ARGON2_INTERACTIVE, CRYPTO_SIZES, type CryptoBackend } from './types';

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
    const body = await this.backend.aeadEncrypt({
      plaintext: utf8Encode(plaintext),
      key,
      nonce,
    });
    return encodeEnvelope({ salt, nonce, body });
  }

  async open(encoded: string, passphrase: string): Promise<string> {
    const { salt, nonce, body } = decodeEnvelope(encoded);
    const key = await this.deriveKey(passphrase, salt);
    const plaintext = await this.backend.aeadDecrypt({ ciphertext: body, key, nonce });
    return utf8Decode(plaintext);
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
