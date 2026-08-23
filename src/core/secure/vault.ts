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
  // Correlates the two credential keys so a crash/Keystore failure between writes cannot make a
  // partial connection look active, and a failed double-delete cannot resurrect a forgotten one.
  | 'serverSessionState'
  | 'iCloudAccount'
  | 'dbEncryptionKey'
  // Staging slot for crash-safe DB-key rotation: the new key is written here BEFORE the
  // SQLCipher rekey and promoted to `dbEncryptionKey` only after it succeeds, so a crash
  // mid-rotation is recoverable (see resolveDbKey).
  | 'dbEncryptionKeyPending'
  | 'automationToken'
  // App-lock enabled flag. Lives OUTSIDE the encrypted DB so boot can decide whether
  // to show the UI gate before the database is initialized — hence the vault, not kv.
  | 'appLockEnabled';

export const SERVER_SESSION_STATE = {
  writing: 'writing',
  active: 'active',
  forgotten: 'forgotten',
} as const;

export type ServerSessionState = (typeof SERVER_SESSION_STATE)[keyof typeof SERVER_SESSION_STATE];

export const CREDENTIAL_REMOVAL_FAILURE_MESSAGE =
  "Secure credential removal could not be confirmed. Clear Gator's app data in Android Settings before handing off this device.";

/**
 * Decide whether the three correlated vault values describe a usable server session.
 *
 * A missing marker is the one-time compatibility path for installs created before the marker
 * existed. Every present value other than `active` fails closed, including malformed values.
 */
export function hasActiveServerSession(
  state: string | null,
  address: string | null,
  password: string | null,
): boolean {
  return (state === null || state === SERVER_SESSION_STATE.active) && !!address && !!password;
}

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
