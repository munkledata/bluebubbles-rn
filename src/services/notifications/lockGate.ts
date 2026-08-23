import { isLockExpired } from '@core/security/lockTimeout';

/**
 * Decide whether a background/headless push must be treated as LOCKED — i.e. post a
 * content-less notification and NOT open/decrypt the encrypted DB.
 *
 * A live (hydrated) lock store records both the current gate and when the app entered the
 * background. Re-check the timeout here because Android can deliver FCM while the app remains
 * backgrounded; the foreground AppState listener has not had a chance to call `lock()` yet.
 * A fresh headless/killed-app wake falls back to the persisted app-lock setting.
 */
export function effectivelyLocked(
  lock: {
    enabled: boolean;
    hydrated: boolean;
    locked: boolean;
    lastBackgrounded: number | null;
    timeoutMs: number;
  },
  appLockEnabled: boolean,
  now: number = Date.now(),
): boolean {
  // Treat a store/vault disagreement as enabled. The setting write updates those two stores in
  // sequence, and failing closed for that tiny hand-off is safer than exposing a push.
  const enabled = appLockEnabled || (lock.hydrated && lock.enabled);
  if (!enabled) return false;
  if (!lock.hydrated) return true;
  return lock.locked || isLockExpired(lock.lastBackgrounded, now, lock.timeoutMs);
}
