import { getDatabase } from '@db/database';
import {
  completePermissionOnboarding as commitPermissionOnboarding,
  useFeatureSettingsStore,
  type AutoDownloadDestination,
} from '@state/featureSettingsStore';
import {
  captureRealtimeDeliveryLease,
  runAccountScopedLocalMutation,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';
import { runAccountOperation } from './realtime/accountOperation';

// Destination choices can wait behind Android permission UI. Invalidate them synchronously when a
// newer destination or auto-download toggle is chosen, before either command reaches its first
// await, so an older Gallery/Album prompt can never publish after App/Off won.
let autoDownloadPolicyChoiceGeneration = 0;

function beginAutoDownloadPolicyChoice(): number {
  autoDownloadPolicyChoiceGeneration += 1;
  return autoDownloadPolicyChoiceGeneration;
}

function isCurrentAutoDownloadPolicyChoice(
  generation: number,
  accountLease: RealtimeDeliveryLease,
): boolean {
  return generation === autoDownloadPolicyChoiceGeneration && accountLease.isCurrent();
}

/** Persist the first-connect permission step for the exact account that owns the screen. */
export async function finishPermissionOnboarding(
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  isRouteCurrent: () => boolean = () => accountLease.isCurrent(),
): Promise<boolean> {
  const canCommit = (): boolean => accountLease.isCurrent() && isRouteCurrent();
  const result = await runAccountOperation(accountLease, () =>
    commitPermissionOnboarding({ db: getDatabase(), shouldCommit: canCommit }),
  );
  return result.ok && result.value && canCommit();
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

/** Account-owned auto-download toggle; disabling also cancels every pending outside-copy intent. */
export function setAttachmentAutoDownloadEnabled(
  enabled: boolean,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  // In particular, Off supersedes an older external destination still waiting on permission.
  beginAutoDownloadPolicyChoice();
  return runAccountScopedLocalMutation(accountLease, () =>
    useFeatureSettingsStore.getState().setFlag('autoDownloadAttachments', enabled, {
      db: getDatabase(),
      shouldCommit: () => accountLease.isCurrent(),
    }),
  );
}

export type AutoDownloadDestinationUpdateResult = 'updated' | 'denied' | 'stale';

/**
 * User-initiated outside-copy policy change. External destinations request write-only Photos
 * permission here; passive queue drains only check it and can therefore never surprise the user
 * with a resume-time dialog.
 */
export async function setAttachmentAutoDownloadDestination(
  destination: AutoDownloadDestination,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<AutoDownloadDestinationUpdateResult> {
  const generation = beginAutoDownloadPolicyChoice();
  let result: AutoDownloadDestinationUpdateResult = 'stale';
  await runAccountScopedLocalMutation(accountLease, async () => {
    if (!isCurrentAutoDownloadPolicyChoice(generation, accountLease)) return;
    if (destination !== 'app') {
      const { requestImageLibrarySavePermission } = await import('./media');
      const permitted = await requestImageLibrarySavePermission();
      if (!isCurrentAutoDownloadPolicyChoice(generation, accountLease)) return;
      if (!permitted) {
        result = 'denied';
        return;
      }
    }
    // Re-selecting the default Album destination is also how a user can grant Photos permission.
    // Once granted, retain its waiting receipts instead of treating the unchanged value as a
    // policy replacement. The generation created above still supersedes an older open prompt.
    if (useFeatureSettingsStore.getState().autoDownloadDestination === destination) {
      if (destination !== 'app') {
        const { drainPendingAttachmentMediaExports } =
          await import('./download/attachmentMediaExportQueue');
        if (!isCurrentAutoDownloadPolicyChoice(generation, accountLease)) return;
        await drainPendingAttachmentMediaExports(accountLease);
      }
      result = 'updated';
      return;
    }
    await useFeatureSettingsStore.getState().setAutoDownloadDestination(destination, {
      db: getDatabase(),
      shouldCommit: () => isCurrentAutoDownloadPolicyChoice(generation, accountLease),
    });
    if (isCurrentAutoDownloadPolicyChoice(generation, accountLease)) result = 'updated';
  });
  return isCurrentAutoDownloadPolicyChoice(generation, accountLease) ? result : 'stale';
}
