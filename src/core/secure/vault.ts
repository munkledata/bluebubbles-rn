/**
 * Secure credential vault.
 *
 * The Flutter app stored the server password, address, iCloud account, and
 * custom headers in PLAINTEXT SharedPreferences (settings.dart). Here they live
 * behind this interface, implemented in the app by expo-secure-store (backed by
 * the Android Keystore). Only secrets go here; non-sensitive UI prefs stay in
 * ordinary key-value storage.
 */
export type SecretKey =
  | 'serverPassword'
  | 'serverAddress'
  | 'iCloudAccount'
  | 'dbEncryptionKey'
  // Staging slot for crash-safe DB-key rotation: the new key is written here BEFORE the
  // SQLCipher rekey and promoted to `dbEncryptionKey` only after it succeeds, so a crash
  // mid-rotation is recoverable (see resolveDbKey).
  | 'dbEncryptionKeyPending'
  | 'automationToken'
  // App-lock enabled flag. Lives OUTSIDE the encrypted DB (it must be readable at
  // cold boot BEFORE the DB key is released) — hence the vault, not the kv table.
  | 'appLockEnabled'
  // TLS public-key pins (JSON: host → base64 SHA-256 SPKI hashes). Applied at boot
  // before any network call; outside the DB so pinning is active before sync/connect.
  | 'certPins';

export interface SecureVault {
  get(key: SecretKey): Promise<string | null>;
  set(key: SecretKey, value: string): Promise<void>;
  delete(key: SecretKey): Promise<void>;
}

/** In-memory vault for tests and the composition root before native init. */
export class InMemoryVault implements SecureVault {
  private readonly store = new Map<SecretKey, string>();

  async get(key: SecretKey): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: SecretKey, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: SecretKey): Promise<void> {
    this.store.delete(key);
  }
}
