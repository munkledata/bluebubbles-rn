/**
 * Decide whether a background/headless push must be treated as LOCKED — i.e. post a
 * content-less notification and NOT open/decrypt the encrypted DB.
 *
 * A live (hydrated) lock store is authoritative: in a foreground/backgrounded session it
 * reflects whether the user has unlocked. A fresh headless/killed-app wake (where boot()
 * never ran, so the store is at its default and NOT hydrated) falls back to the persisted
 * app-lock setting — when the feature is on, a freshly-woken app is treated as locked.
 */
export function effectivelyLocked(
  lock: { hydrated: boolean; locked: boolean },
  appLockEnabled: boolean,
): boolean {
  return lock.hydrated ? lock.locked : appLockEnabled;
}
