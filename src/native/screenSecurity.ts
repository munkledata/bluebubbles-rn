import { requireOptionalNativeModule } from 'expo';

interface GatorScreenSecurityNative {
  setAppLockEnabled: (enabled: boolean) => void;
  /** Present from the F-12 native build on; older binaries lack it. */
  getAppLockEnabled?: () => boolean;
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

/**
 * The native mirror of the App Lock choice, or null when no build carries it. The vault entry is
 * the source of truth; this mirror only breaks the tie when the vault entry is missing (F-12).
 */
export function getNativeAppLockEnabled(): boolean | null {
  const native = getNative();
  if (!native?.getAppLockEnabled) return null;
  try {
    return native.getAppLockEnabled() === true;
  } catch {
    return null;
  }
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
