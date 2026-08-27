import { getDatabase } from '@db/database';
import {
  completePermissionOnboarding as commitPermissionOnboarding,
  useFeatureSettingsStore,
} from '@state/featureSettingsStore';
import {
  captureRealtimeDeliveryLease,
  runAccountScopedLocalMutation,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';

/** Persist the first-connect permission step for the exact account that owns the screen. */
export async function finishPermissionOnboarding(
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  isRouteCurrent: () => boolean = () => accountLease.isCurrent(),
): Promise<boolean> {
  let completed = false;
  const canCommit = (): boolean => accountLease.isCurrent() && isRouteCurrent();
  await runAccountScopedLocalMutation(accountLease, async () => {
    completed = await commitPermissionOnboarding({
      db: getDatabase(),
      shouldCommit: canCommit,
    });
  });
  return completed && canCommit();
}

/** Persist and publish the explicit error-reporting consent choice for one account. */
export function setErrorReportingConsent(
  enabled: boolean,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  return runAccountScopedLocalMutation(accountLease, () =>
    useFeatureSettingsStore.getState().setErrorReportingConsent(enabled, {
      db: getDatabase(),
      shouldCommit: () => accountLease.isCurrent(),
    }),
  );
}
