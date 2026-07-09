import * as LocalAuthentication from 'expo-local-authentication';

/**
 * Biometric / device-credential gate (expo-local-authentication).
 *
 * Used for the optional app lock and to guard release of the DB encryption key.
 */
export async function isBiometricAvailable(): Promise<boolean> {
  const [hasHardware, isEnrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
  ]);
  return hasHardware && isEnrolled;
}

/** Prompt for biometrics/passcode. Returns true on success. */
export async function authenticate(reason = 'Unlock Gator'): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: reason,
    // Allow falling back to device PIN/pattern if biometrics fail.
    disableDeviceFallback: false,
  });
  return result.success;
}
