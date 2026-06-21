import * as sodium from 'react-native-libsodium';
import type { CryptoBackend } from '@core/crypto';

/**
 * Production `CryptoBackend` over react-native-libsodium — native XChaCha20-Poly1305
 * AEAD + Argon2id KDF. A 1:1 mirror of the libsodium-wrappers test backend
 * (`test/support/libsodiumBackend.ts`), so the crypto exercised in Jest is the crypto
 * that runs on device.
 *
 * This file is loaded ONLY via a dynamic `import()` at the composition root
 * (`getSecretBox()` in `src/services/index.ts`), so the native binding is never
 * evaluated at app startup. A JS bundle running on a build that hasn't yet linked the
 * native module therefore won't crash — crypto initializes lazily on first use (the
 * lazy native-module import discipline).
 *
 * On Android the native build includes Argon2id (`crypto_pwhash`); `await ready`
 * guarantees the core is initialized before the first call. (The `loadSumoVersion`
 * dance in the library README is web-only and not needed here — this app is
 * Android-only.)
 */
export async function createNativeCryptoBackend(): Promise<CryptoBackend> {
  await sodium.ready;
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

    // NOTE: react-native-libsodium's NATIVE binding requires `additional_data` to be a
    // STRING — it throws "input type not yet implemented" on null or a Uint8Array (unlike
    // the lenient libsodium-wrappers used in Jest, which is why this only surfaced on
    // device). We never use AAD, so pass '' when absent.
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
