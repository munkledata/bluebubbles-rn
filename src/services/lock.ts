import { useLockStore } from '@state/lockStore';
import { useSessionStore } from '@state/sessionStore';
import { logger } from '@core/secure';
import { isDevServer } from '@utils/isDev';
import { vault } from './clients';
import { flushErrorReports } from './errors';
import { pauseRealtime, resumeRealtime } from './realtimeControl';
import { recoverOutgoing } from './send';

// ── App lock ───────────────────────────────────────────────────────────────────
// The lock setting lives in the vault (NOT the encrypted DB) so it's readable at
// cold boot before the foreground app opens the DB. When lock is on, the foreground coordinator
// defers DB/session initialization until `unlockForegroundBoot(renderedRunId)` follows auth.
// The SecureStore key is deliberately not user-auth-bound. The locked FCM path still refuses to
// open the DB and posts a generic notice, but the key itself has no biometric custody boundary.
// App Lock is therefore a foreground/policy gate, not extra at-rest encryption.

export class InvalidAppLockSettingError extends Error {
  constructor() {
    super('The persisted App Lock value is invalid.');
    this.name = 'InvalidAppLockSettingError';
  }
}

/** Read the persisted app-lock setting from the vault (no DB needed) and apply it. */
export async function hydrateLock(options: { shouldCommit?: () => boolean } = {}): Promise<void> {
  const v = await vault.get('appLockEnabled');
  if (v !== null && v !== 'true' && v !== 'false') throw new InvalidAppLockSettingError();
  if (options.shouldCommit && !options.shouldCommit()) return;
  useLockStore.getState().hydrate(v === 'true');
}

/** Persist the app-lock setting. Callers must confirm biometrics exist before enabling. */
export async function setAppLockEnabled(enabled: boolean): Promise<void> {
  await vault.set('appLockEnabled', enabled ? 'true' : 'false');
  useLockStore.getState().setEnabled(enabled);
  // Settings is inside the connected layout. Turning App Lock on replaces that layout with the
  // lock gate, whose unmount cleanup removes listeners but does not itself close the live socket.
  // Stop intake in the same synchronous state transition so no private event can write behind it.
  if (enabled) pauseRealtime();
}

/** After a successful WARM unlock, clear the gate and resume optional connected work. */
export async function completeUnlock(): Promise<void> {
  const coldBoot = useSessionStore.getState().status === 'loading';
  if (coldBoot) {
    // Cold unlock is owned by foregroundBoot.unlock(renderedRunId). Clearing this store flag here
    // would expose routes while the coordinator is still opening the DB/settings or after a stale
    // biometric callback. Keep this compatibility function fail-closed for accidental callers.
    logger.warn('[lock] ignored cold unlock without foreground boot run ownership');
    return;
  }
  useLockStore.getState().unlock();
  // A warm resume deliberately kept realtime paused while the lock overlay was present. AppState
  // does not emit another `active` transition after biometric success, so resume explicitly now.
  // Cold boot already starts realtime from its coordinator-owned activation after authentication.
  if (!coldBoot && useSessionStore.getState().status === 'connected') {
    // Authentication succeeded: recovery is best-effort and must never keep the lock overlay up.
    // These are independent for the same reason they are in the foreground AppState path — one
    // unavailable subsystem must not prevent the others from catching up.
    void resumeRealtime().catch((error: unknown) => {
      logger.warn('[realtime] post-unlock resume failed', error);
    });
    void flushErrorReports().catch((error: unknown) => {
      logger.warn('[errors] post-unlock flush failed', error);
    });
    if (!isDevServer()) {
      void recoverOutgoing().catch((error: unknown) => {
        logger.warn('[send] post-unlock recovery failed', error);
      });
    }
  }
}
