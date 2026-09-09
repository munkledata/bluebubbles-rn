import { AppState } from 'react-native';
import { logger } from '@core/secure';
import { getDatabase } from '@db/database';
import {
  ATTACHMENT_MEDIA_EXPORT_MAX_DRAIN,
  claimNextAttachmentMediaExport,
  completeAttachmentMediaExport,
  failAttachmentMediaExport,
  maintainAttachmentMediaExports,
  type AttachmentMediaExportDestination,
  type ClaimedAttachmentMediaExport,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useLockStore } from '@state/lockStore';
import { useSessionStore } from '@state/sessionStore';
import { getImageLibrarySavePermission, saveImageToLibrary } from '@/services/media';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';

export interface AttachmentMediaExportDrainResult {
  readonly savedImages: number;
  readonly destination: AttachmentMediaExportDestination | null;
}

const NO_MEDIA_EXPORT: AttachmentMediaExportDrainResult = {
  savedImages: 0,
  destination: null,
};

let claimTokenSequence = 0;
let nativeExportTail: Promise<void> = Promise.resolve();
let passiveDrainFlight:
  | {
      readonly generation: number;
      readonly promise: Promise<AttachmentMediaExportDrainResult>;
    }
  | undefined;

function nextClaimToken(lease: RealtimeDeliveryLease): string {
  claimTokenSequence = (claimTokenSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `ame:${lease.generation}:${Date.now().toString(36)}:${claimTokenSequence.toString(36)}`;
}

/** Keep MediaStore writes sequential without holding the DB writer queue across native work. */
function serializeNativeExports<T>(task: () => Promise<T>): Promise<T> {
  const result = nativeExportTail.then(task, task);
  nativeExportTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function activeDestination(): AttachmentMediaExportDestination | null {
  const settings = useFeatureSettingsStore.getState();
  const session = useSessionStore.getState();
  if (
    AppState.currentState !== 'active' ||
    useLockStore.getState().locked ||
    session.status !== 'connected' ||
    !session.origin ||
    !session.password ||
    !settings.hydrated ||
    !settings.autoDownloadAttachments ||
    settings.autoDownloadDestination === 'app'
  ) {
    return null;
  }
  return settings.autoDownloadDestination;
}

function claimIdentity(claim: ClaimedAttachmentMediaExport) {
  return {
    id: claim.id,
    claimVersion: claim.claimVersion,
    leaseToken: claim.leaseToken,
  };
}

async function settleFailedExport(
  db: AppDatabase,
  claim: ClaimedAttachmentMediaExport,
  result: 'skipped' | 'denied' | 'error',
  lease: RealtimeDeliveryLease,
): Promise<void> {
  if (!lease.isCurrent()) return;
  await failAttachmentMediaExport(
    db,
    claimIdentity(claim),
    result === 'denied'
      ? 'permission-denied'
      : result === 'skipped'
        ? 'source-missing'
        : 'native-error',
    () => lease.isCurrent(),
  );
}

async function drainInsideNativeOwner(
  db: AppDatabase,
  lease: RealtimeDeliveryLease,
  attachmentGuid?: string,
): Promise<AttachmentMediaExportDrainResult> {
  const destination = activeDestination();
  if (!lease.isCurrent() || destination === null) return NO_MEDIA_EXPORT;

  // Maintenance is independent of native permission. Run it first so denied permission cannot
  // leave expired, exhausted, or now-ineligible receipts protecting cache files indefinitely.
  await maintainAttachmentMediaExports(db, () => lease.isCurrent());
  if (!lease.isCurrent() || activeDestination() !== destination) return NO_MEDIA_EXPORT;

  // A passive retry must never open a permission dialog. If the user has not granted the required
  // write access yet, leave the durable receipt unclaimed for a later foreground activation.
  let permitted = false;
  try {
    permitted = await getImageLibrarySavePermission();
  } catch (error) {
    if (lease.isCurrent()) {
      logger.debug('[mediaExport] Photos permission check unavailable', error);
    }
  }
  if (!lease.isCurrent() || !permitted || activeDestination() !== destination) {
    return NO_MEDIA_EXPORT;
  }

  let savedImages = 0;
  const limit = attachmentGuid === undefined ? ATTACHMENT_MEDIA_EXPORT_MAX_DRAIN : 1;
  for (let index = 0; index < limit; index += 1) {
    if (!lease.isCurrent() || activeDestination() !== destination) break;
    const claim = await claimNextAttachmentMediaExport(
      db,
      {
        leaseToken: nextClaimToken(lease),
        attachmentGuid,
        destination,
      },
      () => lease.isCurrent(),
    );
    if (!claim) break;

    // Settings/App Lock/AppState can change after the DB claim. Recheck immediately before the
    // irreversible native call. A revoked claim simply expires and is reclaimed later if policy
    // becomes eligible again; a setting change also deletes old pending receipts atomically.
    if (!lease.isCurrent() || activeDestination() !== claim.destination) break;
    const result = await saveImageToLibrary(claim.localPath, {
      album: claim.destination === 'album',
      permissionMode: 'check',
    });
    if (result !== 'saved') {
      await settleFailedExport(db, claim, result, lease);
      if (result === 'denied') break;
      continue;
    }
    if (!lease.isCurrent()) break;
    const completed = await completeAttachmentMediaExport(db, claimIdentity(claim), () =>
      lease.isCurrent(),
    );
    if (completed && lease.isCurrent()) savedImages += 1;
  }

  return savedImages === 0 ? NO_MEDIA_EXPORT : { savedImages, destination };
}

async function runMediaExportDrain(
  db: AppDatabase,
  lease: RealtimeDeliveryLease,
  attachmentGuid?: string,
): Promise<AttachmentMediaExportDrainResult> {
  let outcome = NO_MEDIA_EXPORT;
  try {
    await runTrackedRealtimeWork(lease, async (activeLease) => {
      outcome = await serializeNativeExports(() =>
        drainInsideNativeOwner(db, activeLease, attachmentGuid),
      );
    });
  } catch (error) {
    if (lease.isCurrent()) logger.debug('[mediaExport] foreground drain failed', error);
  }
  return lease.isCurrent() ? outcome : NO_MEDIA_EXPORT;
}

/** Try the receipt for the image whose private-cache download just completed. */
export function fulfillAttachmentMediaExport(
  db: AppDatabase,
  attachmentGuid: string,
  lease: RealtimeDeliveryLease,
): Promise<AttachmentMediaExportDrainResult> {
  return runMediaExportDrain(db, lease, attachmentGuid);
}

/** Bounded mount/resume retry for receipts left by killed or background delivery. */
export function drainPendingAttachmentMediaExports(
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<AttachmentMediaExportDrainResult> {
  const existing = passiveDrainFlight;
  if (existing?.generation === lease.generation) return existing.promise;

  let db: AppDatabase;
  try {
    db = getDatabase();
  } catch (error) {
    return Promise.reject(error);
  }
  const promise = runMediaExportDrain(db, lease);
  const flight = { generation: lease.generation, promise };
  passiveDrainFlight = flight;
  const clearFlight = (): void => {
    if (passiveDrainFlight === flight) passiveDrainFlight = undefined;
  };
  void promise.then(clearFlight, clearFlight);
  return promise;
}
