import { getDatabase } from '@db/database';
import { DbCommitGuardRejectedError } from '@db/transaction';
import { accountHttp } from './clients';
import {
  prepareExactIMessageGroupPhotoSet,
  removeExactIMessageGroupPhoto,
  type AppleGroupPhotoResult,
  type GroupPhotoUploader,
  type PickedGroupPhoto,
  type RemoveAppleGroupPhotoArgs,
} from './groupPhotoService';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';
import { captureSessionRcsCapabilityLease } from './send/rcsAttemptCapability';

// Keep Expo's native file module out of the evaluation-safe services barrel until this exact
// foreground operation reaches its already-pinned upload boundary.
const productionGroupPhotoUploader: GroupPhotoUploader = (input) => {
  /* eslint-disable @typescript-eslint/no-require-imports -- Keep native upload code lazy and Metro-visible. */
  const { expoGroupPhotoUploader } =
    require('./groupPhotoUpload') as typeof import('./groupPhotoUpload');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return expoGroupPhotoUploader(input);
};

export interface PreparedAppleGroupPhotoSet {
  /** Consume this exact pre-picker account/origin/auth/capability grant once. */
  submit(image: PickedGroupPhoto): Promise<AppleGroupPhotoResult | null>;
  /** Release the grant when permission is denied or the picker is cancelled. */
  cancel(): void;
}

/**
 * Capture and prove every remote authority before native picker UI opens. The returned single-use
 * grant retains the exact pinned transport/capability and cannot adopt a later session.
 */
export async function prepareAppleGroupPhotoSet(
  chatGuid: string,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<PreparedAppleGroupPhotoSet | null> {
  const preparedHolder: {
    value: Awaited<ReturnType<typeof prepareExactIMessageGroupPhotoSet>>;
  } = { value: null };
  let completed = false;
  try {
    const status = await runTrackedRealtimeWork(accountLease, async (lease) => {
      if (!lease.isCurrent()) return;
      const capability = captureSessionRcsCapabilityLease();
      if (
        !capability ||
        capability.serverInfo?.supports_imessage_group_photo !== true ||
        !capability.isCurrent()
      ) {
        completed = true;
        return;
      }
      preparedHolder.value = await prepareExactIMessageGroupPhotoSet(
        getDatabase(),
        accountHttp(lease),
        chatGuid,
        productionGroupPhotoUploader,
        () => lease.isCurrent(),
        capability,
      );
      if (lease.isCurrent()) completed = true;
    });
    if (
      status !== 'delivered' ||
      !completed ||
      !accountLease.isCurrent() ||
      !preparedHolder.value
    ) {
      preparedHolder.value?.cancel();
      return null;
    }
  } catch (error) {
    preparedHolder.value?.cancel();
    if (!accountLease.isCurrent() || error instanceof DbCommitGuardRejectedError) return null;
    throw error;
  }

  const owner = preparedHolder.value;
  let consumed = false;
  return Object.freeze({
    cancel: () => {
      if (consumed) return;
      consumed = true;
      owner.cancel();
    },
    submit: async (image: PickedGroupPhoto): Promise<AppleGroupPhotoResult | null> => {
      if (consumed) return null;
      consumed = true;
      if (!accountLease.isCurrent()) {
        owner.cancel();
        return null;
      }
      let result: AppleGroupPhotoResult | null = null;
      let delivered = false;
      try {
        const status = await runTrackedRealtimeWork(accountLease, async (lease) => {
          if (!lease.isCurrent()) return;
          result = await owner.submit({ ...image });
          if (lease.isCurrent()) delivered = true;
        });
        return status === 'delivered' && delivered && accountLease.isCurrent() ? result : null;
      } catch (error) {
        if (!accountLease.isCurrent() || error instanceof DbCommitGuardRejectedError) return null;
        throw error;
      }
    },
  });
}

/** Account-scoped remove entry; no local photo state is changed optimistically. */
export async function removeAppleGroupPhoto(
  args: RemoveAppleGroupPhotoArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<AppleGroupPhotoResult | null> {
  const snapshot = { ...args };
  let completed = false;
  let result: AppleGroupPhotoResult | null = null;
  try {
    const status = await runTrackedRealtimeWork(accountLease, async (lease) => {
      if (!lease.isCurrent()) return;
      const capability = captureSessionRcsCapabilityLease();
      if (
        !capability ||
        capability.serverInfo?.supports_imessage_group_photo !== true ||
        !capability.isCurrent()
      ) {
        completed = true;
        return;
      }
      result = await removeExactIMessageGroupPhoto(
        getDatabase(),
        accountHttp(lease),
        snapshot,
        () => lease.isCurrent(),
        capability,
      );
      if (lease.isCurrent()) completed = true;
    });
    return status === 'delivered' && completed && accountLease.isCurrent() ? result : null;
  } catch (error) {
    if (!accountLease.isCurrent() || error instanceof DbCommitGuardRejectedError) return null;
    throw error;
  }
}
