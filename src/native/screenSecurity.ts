import { requireOptionalNativeModule } from 'expo';

interface GatorScreenSecurityNative {
  setAppLockEnabled: (enabled: boolean) => void;
  completeForegroundTransition: () => boolean;
  getSecureScreenEnabled: () => boolean;
  setSecureScreenEnabled: (enabled: boolean) => void;
}

export interface SecureScreenState {
  available: boolean;
  enabled: boolean;
}

function getNative(): GatorScreenSecurityNative | null {
  try {
    return requireOptionalNativeModule<GatorScreenSecurityNative>('GatorScreenSecurity');
  } catch {
    return null;
  }
}

/** Mirror the vault-backed App Lock choice into the synchronous Android lifecycle owner. */
export function setNativeAppLockEnabled(enabled: boolean): boolean {
  const native = getNative();
  if (!native) return false;
  native.setAppLockEnabled(enabled);
  return true;
}

/** Release the legacy fallback only after JavaScript has completed the active lock decision. */
export function completeNativeForegroundPrivacyTransition(): boolean {
  return getNative()?.completeForegroundTransition() ?? false;
}

/** Read the independent native-persisted screenshot/recording preference. */
export function getSecureScreenState(): SecureScreenState {
  const native = getNative();
  return native
    ? { available: true, enabled: native.getSecureScreenEnabled() }
    : { available: false, enabled: false };
}

export function setSecureScreenEnabled(enabled: boolean): void {
  const native = getNative();
  if (!native) throw new Error('Secure Screen requires an Android build with native support.');
  native.setSecureScreenEnabled(enabled);
}
