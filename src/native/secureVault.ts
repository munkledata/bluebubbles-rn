import * as SecureStore from 'expo-secure-store';
import type { SecretKey, SecureVault } from '@core/secure';

/**
 * SecureVault backed by expo-secure-store (Android Keystore + EncryptedSharedPrefs).
 *
 * This is the fix for the Flutter app storing the server password/address in
 * PLAINTEXT SharedPreferences. Keys are stable, alphanumeric SecretKey strings.
 *
 * DECISION (F-10/F-32): `requireAuthentication` is intentionally OFF. A headless killed-app
 * FCM push must be able to read the SQLCipher key whenever App Lock is disabled or its live grace
 * window still considers the UI unlocked. Turning `requireAuthentication` on would gate every
 * such wake behind a biometric prompt that cannot run headlessly, dropping delivery. When the
 * App Lock policy considers the app locked, `deliverRespectingLock` refuses to open the DB and
 * posts a generic notice instead. The bare emulator also has no enrolled biometric. App Lock is
 * therefore a foreground/policy gate, NOT user-auth-bound at-rest key custody.
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
