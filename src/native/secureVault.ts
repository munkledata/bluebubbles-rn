import * as SecureStore from 'expo-secure-store';
import type { SecretKey, SecureVault } from '@core/secure';

/**
 * SecureVault backed by expo-secure-store (Android Keystore + EncryptedSharedPrefs).
 *
 * This is the fix for the Flutter app storing the server password/address in
 * PLAINTEXT SharedPreferences. Keys are stable, alphanumeric SecretKey strings.
 *
 * DECISION (F-10/F-32): `requireAuthentication` is intentionally OFF. A headless killed-app
 * FCM push must be able to decrypt the DB (read the SQLCipher key from this vault) WHILE the
 * app is locked, to write the message + post a notification (content is gated separately by
 * redacted/locked mode — see deliverRespectingLock). Turning `requireAuthentication` on would
 * gate the key behind a biometric prompt that can't run in the headless context, dropping
 * killed-app delivery. The bare emulator also has no enrolled biometric, which would lock it
 * out entirely. So app-lock is a UI gate over delivery, NOT at-rest key custody.
 *
 * `keychainAccessible: WHEN_UNLOCKED` is an iOS-only attribute and is INERT on Android (the
 * Android Keystore has no equivalent "accessible only when device unlocked" flag applied here);
 * it's kept only for the (currently unused) iOS path and does NOT provide an at-rest guarantee
 * on Android. Do not rely on it for key custody.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED,
};

export class ExpoSecureVault implements SecureVault {
  async get(key: SecretKey): Promise<string | null> {
    return SecureStore.getItemAsync(key, OPTIONS);
  }

  async set(key: SecretKey, value: string): Promise<void> {
    await SecureStore.setItemAsync(key, value, OPTIONS);
  }

  async delete(key: SecretKey): Promise<void> {
    await SecureStore.deleteItemAsync(key, OPTIONS);
  }
}
