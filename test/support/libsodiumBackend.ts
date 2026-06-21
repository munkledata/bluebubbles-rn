// The "sumo" build is required for Argon2id (crypto_pwhash); the lite build omits it.
import _sodium from 'libsodium-wrappers-sumo';
import type { CryptoBackend } from '@core/crypto';

/**
 * CryptoBackend backed by `libsodium-wrappers-sumo` (pure-JS/WASM) for use in
 * Node tests. The app ships an equivalent backend over `react-native-libsodium`
 * in src/native/crypto — same interface, native speed.
 */
export async function createLibsodiumBackend(): Promise<CryptoBackend> {
  await _sodium.ready;
  const sodium = _sodium;

  return {
    async randomBytes(length: number): Promise<Uint8Array> {
      return sodium.randombytes_buf(length);
    },

    async deriveKey({ passphrase, salt, keyLength, opsLimit, memLimit }): Promise<Uint8Array> {
      return sodium.crypto_pwhash(
        keyLength,
        passphrase,
        salt,
        opsLimit,
        memLimit,
        sodium.crypto_pwhash_ALG_ARGON2ID13,
      );
    },

    async aeadEncrypt({ plaintext, key, nonce, additionalData }): Promise<Uint8Array> {
      return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext,
        additionalData ?? '',
        null,
        nonce,
        key,
      );
    },

    async aeadDecrypt({ ciphertext, key, nonce, additionalData }): Promise<Uint8Array> {
      return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        ciphertext,
        additionalData ?? '',
        nonce,
        key,
      );
    },
  };
}
