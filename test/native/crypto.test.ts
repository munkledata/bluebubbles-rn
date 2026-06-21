/**
 * Contract test for the PRODUCTION crypto backend (src/native/crypto.ts).
 *
 * On device it binds to `react-native-libsodium` (a native module Jest can't load),
 * so we mock that import with the pure-JS `libsodium-wrappers-sumo` — the same
 * primitives, exposed as the named exports react-native-libsodium provides. This
 * verifies the exact argument WIRING in src/native/crypto.ts (nonce vs key order,
 * additional-data position, Argon2id params) against real XChaCha20-Poly1305 + Argon2id
 * crypto, by round-tripping through the real SecretBox. If an arg is transposed, the
 * AEAD auth tag fails and these tests go red.
 */
jest.mock('react-native-libsodium', () => {
  // Lazily delegate to the sumo build; its functions/constants only exist after
  // `ready`, so defer every access (the backend awaits `ready` before calling).
  const s = require('libsodium-wrappers-sumo');
  return {
    get ready() {
      return s.ready;
    },
    get crypto_pwhash_ALG_ARGON2ID13() {
      return s.crypto_pwhash_ALG_ARGON2ID13;
    },
    randombytes_buf: (...a: unknown[]) => s.randombytes_buf(...a),
    crypto_pwhash: (...a: unknown[]) => s.crypto_pwhash(...a),
    crypto_aead_xchacha20poly1305_ietf_encrypt: (...a: unknown[]) =>
      s.crypto_aead_xchacha20poly1305_ietf_encrypt(...a),
    crypto_aead_xchacha20poly1305_ietf_decrypt: (...a: unknown[]) =>
      s.crypto_aead_xchacha20poly1305_ietf_decrypt(...a),
  };
});

import { SecretBox } from '@core/crypto';
import { createNativeCryptoBackend } from '@native/crypto';

describe('native crypto backend (react-native-libsodium wiring)', () => {
  // Argon2id is intentionally slow; lightest params for test speed.
  const cheapArgon = { opsLimit: 1, memLimit: 8 * 1024 * 1024 };

  it('produces a CryptoBackend that round-trips through SecretBox', async () => {
    const backend = await createNativeCryptoBackend();
    const box = new SecretBox(backend, cheapArgon);
    const secret = 'super-secret-server-password';
    const sealed = await box.seal(secret, 'passphrase-123');
    expect(sealed).not.toContain(secret);
    expect(await box.open(sealed, 'passphrase-123')).toBe(secret);
  });

  it('rejects a wrong passphrase (authenticated decryption)', async () => {
    const box = new SecretBox(await createNativeCryptoBackend(), cheapArgon);
    const sealed = await box.seal('data', 'right');
    await expect(box.open(sealed, 'wrong')).rejects.toBeDefined();
  });

  it('emits a unique salt + nonce per seal (no key/nonce reuse)', async () => {
    const box = new SecretBox(await createNativeCryptoBackend(), cheapArgon);
    const a = await box.seal('same', 'pw');
    const b = await box.seal('same', 'pw');
    expect(a).not.toBe(b);
  });
});
