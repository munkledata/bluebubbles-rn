import { useLockStore } from '@state/lockStore';
import { useSessionStore } from '@state/sessionStore';
import { logger } from '@core/secure';
import { isDevServer } from '@utils/isDev';
import { setNativeAppLockEnabled } from '@native/screenSecurity';
import { vault } from './clients';
import { flushErrorReports } from './errors';
import { pauseRealtime, resumeRealtime } from './realtimeControl';
import { recoverOutgoing } from './send';
import {
  beginAppLockNotificationPrivacy,
  clearLockedNotification,
  commitAppLockNotificationPrivacy,
  reconcileMessageNotificationGroup,
} from './notifications/notifeeService';
import { clearCurrentShareShortcuts } from './shortcuts/shareShortcuts';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
} from './realtime/deliveryCoordinator';

// ── App lock ───────────────────────────────────────────────────────────────────
// The lock setting lives in the vault (NOT the encrypted DB) so it's readable at
// cold boot before the foreground app opens the DB. When lock is on, the foreground coordinator
// defers DB/session initialization until `unlockForegroundBoot(renderedRunId)` follows auth.
// The SecureStore key is deliberately not user-auth-bound. Locked legacy/V2 FCM still avoids the
// DB; authenticated, active-bound V3 may only enqueue into SQLCipher and cannot read, claim, route,
// or present content before unlock. The key itself has no biometric custody boundary, so App Lock
// remains a foreground/policy gate rather than extra at-rest encryption.

export class InvalidAppLockSettingError extends Error {
  constructor() {
    super('The persisted App Lock value is invalid.');
    this.name = 'InvalidAppLockSettingError';
  }
}

function syncNativeAppLockPolicy(enabled: boolean): void {
  const applied = setNativeAppLockEnabled(enabled);
  if (enabled && !applied) {
    throw new Error('App Lock requires the Android Recents protection module.');
  }
}

function clearPersonalizedShareTargets(): void {
  if (!clearCurrentShareShortcuts()) {
    throw new Error('App Lock requires Direct Share privacy cleanup.');
  }
}

let lockPolicyOperationPending = false;

function beginLockPolicyOperation(): void {
  if (lockPolicyOperationPending) throw new Error('An App Lock update is already in progress.');
  lockPolicyOperationPending = true;
}

/** Read the persisted app-lock setting from the vault (no DB needed) and apply it. */
export async function hydrateLock(options: { shouldCommit?: () => boolean } = {}): Promise<void> {
  beginLockPolicyOperation();
  try {
    const v = await vault.get('appLockEnabled');
    if (v !== null && v !== 'true' && v !== 'false') throw new InvalidAppLockSettingError();
    if (options.shouldCommit && !options.shouldCommit()) return;
    const enabled = v === 'true';
    if (enabled) {
      await beginAppLockNotificationPrivacy();
      if (options.shouldCommit && !options.shouldCommit()) return;
    }
    // App Lock cannot publish while account-derived Direct Share labels remain visible in Android's
    // chooser. Clear them synchronously before the protected React tree can render or unmount.
    if (enabled) clearPersonalizedShareTargets();
    // Synchronize the native Recents owner before the gate can render protected routes. A build
    // without this post-v56 native module keeps the existing React gate but cannot claim Recents
    // protection until rebuilt and device-verified.
    syncNativeAppLockPolicy(enabled);
    useLockStore.getState().hydrate(enabled);
    commitAppLockNotificationPrivacy();
  } finally {
    lockPolicyOperationPending = false;
  }
}

/** Persist the app-lock setting. Callers must confirm biometrics exist before enabling. */
export async function setAppLockEnabled(enabled: boolean): Promise<void> {
  beginLockPolicyOperation();
  const accountLease = captureRealtimeDeliveryLease();
  try {
    const result = await runTrackedRealtimeWork(accountLease, async (activeLease) => {
      // Enabling is fail-closed: install the native Recents policy before persisting/unmounting the
      // protected React tree. Disabling may safely clear the native mirror after the vault commits.
      if (enabled) {
        // Admission is synchronous, before the first await. A failed scrub or vault write retains the
        // notification barrier; do not claim protection succeeded or resume private OS presentation.
        await beginAppLockNotificationPrivacy();
        if (!activeLease.isCurrent())
          throw new Error('The App Lock update was interrupted by Disconnect.');
        clearPersonalizedShareTargets();
        syncNativeAppLockPolicy(true);
      }
      if (!activeLease.isCurrent())
        throw new Error('The App Lock update was interrupted by Disconnect.');
      // App Lock is device policy and survives Disconnect. Once this vault write is admitted, finish
      // its matching store/native commit while teardown drains us; a replacement account cannot
      // overtake it. Before this point, retirement cancels the old Settings request.
      await vault.set('appLockEnabled', enabled ? 'true' : 'false');
      useLockStore.getState().setEnabled(enabled);
      if (!enabled) syncNativeAppLockPolicy(false);
      commitAppLockNotificationPrivacy();
      // Settings is inside the connected layout. Turning App Lock on replaces that layout with the
      // lock gate, whose unmount cleanup removes listeners but does not itself close the live socket.
      // Stop intake in the same synchronous state transition so no private event can write behind it.
      if (enabled) pauseRealtime();
    });
    if (result !== 'delivered')
      throw new Error('The App Lock update was interrupted by Disconnect.');
  } finally {
    lockPolicyOperationPending = false;
  }
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
  // The user is now in the app and can see what arrived: withdraw the generic "You have new
  // messages" notice so it does not linger in the tray after it has been seen.
  void clearLockedNotification().catch((error: unknown) => {
    logger.warn('[notif] post-unlock locked-notice clear failed', error);
  });
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
    void reconcileMessageNotificationGroup().catch((error: unknown) => {
      logger.warn('[notif] post-unlock message-group repair failed', error);
    });
    if (!isDevServer()) {
      void recoverOutgoing().catch((error: unknown) => {
        logger.warn('[send] post-unlock recovery failed', error);
      });
    }
  }
}
