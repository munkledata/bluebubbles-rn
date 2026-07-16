import { useLockStore } from '@state/lockStore';
import { useSessionStore } from '@state/sessionStore';
import { vault } from './clients';
import { hydrateSession } from './bootstrap';

// ── App lock ───────────────────────────────────────────────────────────────────
// The lock setting lives in the vault (NOT the encrypted DB) so it's readable at
// cold boot before the DB key is released. When lock is on, `boot()` withholds the
// SQLCipher key until `completeUnlock()` runs after a successful biometric auth.

/** Read the persisted app-lock setting from the vault (no DB needed) and apply it. */
export async function hydrateLock(): Promise<void> {
  const v = await vault.get('appLockEnabled');
  useLockStore.getState().hydrate(v === 'true');
}

/** Persist the app-lock setting. Callers must confirm biometrics exist before enabling. */
export async function setAppLockEnabled(enabled: boolean): Promise<void> {
  await vault.set('appLockEnabled', enabled ? 'true' : 'false');
  useLockStore.getState().setEnabled(enabled);
}

/** After a successful unlock: open the DB + route if the cold boot deferred it, then clear the gate. */
export async function completeUnlock(): Promise<void> {
  if (useSessionStore.getState().status === 'loading') {
    await hydrateSession();
  }
  useLockStore.getState().unlock();
}
