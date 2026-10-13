import { getDatabase } from '@db/database';
import { DbCommitGuardRejectedError } from '@db/transaction';
import { runCapabilityGatedAccountAction } from './capabilityGatedAction';
import { accountHttp } from './clients';
import {
  prepareExactIMessageGroupPhotoSet,
  removeExactIMessageGroupPhoto,
  type AppleGroupPhotoResult,
  type GroupPhotoUploader,
  type PickedGroupPhoto,
  type RemoveAppleGroupPhotoArgs,
} from './groupPhotoService';
import { runAccountOperation } from './realtime/accountOperation';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';

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
  // Holds a prepared grant even when its result is later dropped, so the grant can be released.
  const preparedHolder: {
    value: Awaited<ReturnType<typeof prepareExactIMessageGroupPhotoSet>>;
  } = { value: null };
  let owner: typeof preparedHolder.value;
  try {
    owner = await runCapabilityGatedAccountAction(
      accountLease,
      'supports_imessage_group_photo',
      async (lease, capability) => {
        preparedHolder.value = await prepareExactIMessageGroupPhotoSet(
          getDatabase(),
          accountHttp(lease),
          chatGuid,
          productionGroupPhotoUploader,
          () => lease.isCurrent(),
          capability,
        );
        return preparedHolder.value;
      },
    );
  } catch (error) {
    preparedHolder.value?.cancel();
    throw error;
  }
  if (!owner) {
    preparedHolder.value?.cancel();
    return null;
  }
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
      try {
        const result = await runAccountOperation(accountLease, () => owner.submit({ ...image }));
        return result.ok ? result.value : null;
      } catch (error) {
        if (error instanceof DbCommitGuardRejectedError) return null;
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
  return runCapabilityGatedAccountAction(
    accountLease,
    'supports_imessage_group_photo',
    (lease, capability) =>
      removeExactIMessageGroupPhoto(
        getDatabase(),
        accountHttp(lease),
        snapshot,
        () => lease.isCurrent(),
        capability,
      ),
  );
}
