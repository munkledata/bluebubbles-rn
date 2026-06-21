import { logger } from '@core/secure';

interface JailMonkey {
  isJailBroken(): boolean;
  canMockLocation(): boolean;
  trustFall(): boolean;
}

/**
 * Best-effort root/jailbreak advisory (jail-monkey). At-rest secrets (the
 * Keystore-backed vault, the SQLCipher key) are weaker on a rooted device, so we
 * surface a redacted warning — but never BLOCK use (advisory only).
 *
 * Lazy-imported and fully guarded: a build that hasn't linked the native module yet
 * (pre-rebuild) is a silent no-op, never a crash — the same deferral discipline as
 * the crypto backend. NOTE: jail-monkey v3 is an older bridge module; confirm it
 * links on the RN 0.85 / new-architecture rebuild.
 */
export async function checkDeviceIntegrity(): Promise<{ compromised: boolean }> {
  try {
    const JailMonkey = (await import('jail-monkey')).default as unknown as JailMonkey;
    const compromised = JailMonkey.isJailBroken() || JailMonkey.canMockLocation();
    if (compromised) {
      logger.warn(
        '[security] device appears rooted/compromised — at-rest secrets are at higher risk',
      );
    }
    return { compromised };
  } catch {
    // Not linked yet (pre-rebuild) or the check threw — advisory is best-effort.
    return { compromised: false };
  }
}
