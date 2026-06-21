import * as SecureStore from 'expo-secure-store';
import type { SecretKey, SecureVault } from '@core/secure';

/**
 * SecureVault backed by expo-secure-store (Android Keystore + EncryptedSharedPrefs).
 *
 * This is the fix for the Flutter app storing the server password/address in
 * PLAINTEXT SharedPreferences. Keys are stable, alphanumeric SecretKey strings.
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
