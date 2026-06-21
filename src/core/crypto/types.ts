/**
 * Crypto backend abstraction.
 *
 * The core layer is native-free, so the actual primitives are injected. The app
 * provides a `react-native-libsodium` backend (src/native/crypto); tests provide
 * a `libsodium-wrappers` backend. This keeps the envelope logic unit-testable in
 * Node and lets us swap implementations without touching call sites.
 *
 * Primitives (replacing the legacy AES-256-CBC + MD5 EVP_BytesToKey scheme):
 *   - KDF:   Argon2id  (passphrase -> 32-byte key)
 *   - AEAD:  XChaCha20-Poly1305 (authenticated, 24-byte nonce)
 */
export interface CryptoBackend {
  /** Cryptographically secure random bytes. */
  randomBytes(length: number): Promise<Uint8Array>;

  /** Argon2id key derivation. Returns `keyLength` bytes. */
  deriveKey(params: {
    passphrase: string;
    salt: Uint8Array;
    keyLength: number;
    opsLimit: number;
    memLimit: number;
  }): Promise<Uint8Array>;

  /** XChaCha20-Poly1305 AEAD encryption. */
  aeadEncrypt(params: {
    plaintext: Uint8Array;
    key: Uint8Array;
    nonce: Uint8Array;
    additionalData?: string;
  }): Promise<Uint8Array>;

  /** XChaCha20-Poly1305 AEAD decryption. Throws on auth failure. */
  aeadDecrypt(params: {
    ciphertext: Uint8Array;
    key: Uint8Array;
    nonce: Uint8Array;
    additionalData?: string;
  }): Promise<Uint8Array>;
}

/** Sizes (bytes) for the XChaCha20-Poly1305 + Argon2id scheme. */
export const CRYPTO_SIZES = {
  key: 32,
  nonce: 24,
  salt: 16,
} as const;

/**
 * Argon2id cost parameters. INTERACTIVE is appropriate for unlocking a key on a
 * mobile device on app open; bump for higher-value secrets if needed.
 */
export const ARGON2_INTERACTIVE = {
  opsLimit: 2,
  memLimit: 64 * 1024 * 1024, // 64 MiB
} as const;
