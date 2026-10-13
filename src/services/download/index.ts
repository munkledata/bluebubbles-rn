import * as Crypto from 'expo-crypto';
import type { HttpClient } from '@core/api';
import { getDatabase } from '@db/database';
import type { AttachmentRow } from '@db/repositories';
import { useDownloadStore } from '@state/downloadStore';
import { sessionAccessors } from '@state/sessionStore';
import { extensionForMime, isLocalFileUri } from '@utils';
import { isDevServer } from '@utils/isDev';
import { http } from '../clients';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';
import {
  attachmentDownloadDestinationIdentity,
  attachmentMetadataAllowsDownload,
  ensureDownloadedOutcome,
  type AttachmentDownloadMode,
  type AttachmentDownloadOutcome,
  type AttachmentDownloadReplacement,
  type AttachmentDownloadScope,
  type AttachmentFetcher,
} from './downloadService';
import {
  attachmentCacheCoordinator,
  type AttachmentCacheReservationScope,
} from './attachmentCacheCoordinator';
import {
  isAttachmentCacheRecoveryReady,
  repairAttachmentCache,
  type AttachmentCacheRepairProgress,
  type AttachmentCacheRepairResult,
} from './attachmentCacheRecovery';
import { expoFetcher } from './expoFetcher';

export type { AttachmentFetcher } from './downloadService';
export { ensureDownloaded } from './downloadService';

const productionFetcher: AttachmentFetcher = expoFetcher(http);
let developmentFetcher: AttachmentFetcher | null = null;

export type { AttachmentCacheRepairProgress, AttachmentCacheRepairResult };

/**
 * Storage → Repair Downloads (review item 888) for the account connected right now. Does nothing
 * once this account's startup cache check has succeeded.
 */
export async function repairStuckDownloads(
  onProgress?: (progress: AttachmentCacheRepairProgress) => void,
): Promise<AttachmentCacheRepairResult> {
  return repairAttachmentCache(
    getDatabase(),
    captureRealtimeDeliveryLease(),
    onProgress ? { onProgress } : {},
  );
}

/** Register the DEV fixture fetcher. Tests use the same hook while mocking an active DEV session. */
export function setAttachmentFetcher(f: AttachmentFetcher): void {
  // Metro defines __DEV__ in every app bundle; plain Node/Jest intentionally does not.
  if (typeof __DEV__ !== 'undefined' && !__DEV__) {
    throw new Error('Attachment fetcher replacement is development-only.');
  }
  developmentFetcher = f;
}

function attachmentFetcherForInvocation(taskHttp?: HttpClient): AttachmentFetcher {
  if (isDevServer() && developmentFetcher) return developmentFetcher;
  return taskHttp ? expoFetcher(taskHttp) : productionFetcher;
}

// RCS media often 404s only TRANSIENTLY: the picture frame can reach the server before its
// decryption key does (the key rides a later bridge frame), so the first fetch has no key and
// fails. A small, BOUNDED backoff retry recovers a user-requested download once the server caches
// the key. Ingestion-path automatic downloads deliberately do NOT retry: their caller owns a
// per-message byte budget, and a detached timer could bypass that accounting. iMessage media is
// not retried because a 404 there is usually permanent.
const MAX_RCS_RETRIES = 3;
const RCS_RETRY_BACKOFF_MS = [2500, 6000, 12000];

interface RcsRetryState {
  readonly owner: symbol;
  readonly destinationIdentity: string;
  retries: number;
  timer: ReturnType<typeof setTimeout> | null;
  unsubscribeInvalidation: () => void;
  releaseProtection: (() => void) | null;
}

/** One retry chain per account generation + attachment. */
const rcsRetryStates = new Map<string, RcsRetryState>();

function replacementFileExtension(att: AttachmentRow): string {
  const mimeExtension = extensionForMime(att.mimeType);
  if (mimeExtension) return mimeExtension;
  const transferName = att.transferName ?? '';
  const dot = transferName.lastIndexOf('.');
  if (dot <= 0 || dot === transferName.length - 1) return '';
  const candidate = transferName.slice(dot);
  return /^\.[a-z0-9]{1,16}$/i.test(candidate) ? candidate.toLowerCase() : '';
}

/**
 * Ensure an attachment is downloaded locally (UI-bound). Reports progress into
 * `useDownloadStore` so the bubble can show a ring / retry. Returns the local
 * path or null. Re-invoking after a failure retries (ensureDownloaded dedupes
 * concurrent calls and clears its in-flight entry on settle). A manually requested
 * RCS download gets a bounded backoff retry (see above); a fresh call supersedes the
 * old chain and resets that backoff.
 */
export function download(
  att: AttachmentRow,
  mode: AttachmentDownloadMode,
  deliveryLease: RealtimeDeliveryLease,
  onVerifiedBytes?: (bytes: number) => void,
  maxBytesOverride?: number,
): Promise<string | null> {
  const ownerFetcher = attachmentFetcherForInvocation();
  return downloadWithFetcher(
    ownerFetcher,
    att,
    mode,
    deliveryLease,
    onVerifiedBytes,
    maxBytesOverride,
  );
}

/** Killed-process/realtime variant whose fetcher is bound to one authorized task-local client. */
export function downloadWithClient(
  client: HttpClient,
  att: AttachmentRow,
  mode: AttachmentDownloadMode,
  deliveryLease: RealtimeDeliveryLease,
  onVerifiedBytes?: (bytes: number) => void,
  maxBytesOverride?: number,
): Promise<string | null> {
  return downloadWithFetcher(
    attachmentFetcherForInvocation(client),
    att,
    mode,
    deliveryLease,
    onVerifiedBytes,
    maxBytesOverride,
  );
}

function downloadWithFetcher(
  ownerFetcher: AttachmentFetcher,
  att: AttachmentRow,
  mode: AttachmentDownloadMode,
  deliveryLease: RealtimeDeliveryLease,
  onVerifiedBytes?: (bytes: number) => void,
  maxBytesOverride?: number,
): Promise<string | null> {
  const scope = downloadScope(deliveryLease, ownerFetcher, att);
  const key = retryKey(att.guid, scope);
  // A forced copy-on-write replacement owns both the damaged source pin and the terminal viewer
  // transition. A stale ordinary request must not revoke it merely to discover that the flight
  // layer considers the two destinations incompatible.
  const destinationIdentity = attachmentDownloadDestinationIdentity();
  if (hasIncompatibleRcsOwner(key, destinationIdentity)) return Promise.resolve(null);
  if (!scope.isCurrent()) {
    cancelRcsRetry(key);
    return Promise.resolve(null);
  }
  // A fresh UI or ingestion intent owns this guid now. Clear both the old count and its sleeping
  // timer; deleting only the count lets an older callback wake and start a second retry chain.
  cancelRcsRetry(key);
  if (!attachmentMetadataAllowsDownload(att.totalBytes, mode)) {
    // An automatic skip is not a failed user action. An explicit tap over the absolute cap should
    // expose the retry/error affordance instead of pretending a transfer started.
    if (mode === 'manual' && scope.isCurrent()) useDownloadStore.getState().fail(att.guid);
    return Promise.resolve(null);
  }
  if (
    maxBytesOverride !== undefined &&
    (!Number.isSafeInteger(maxBytesOverride) ||
      maxBytesOverride <= 0 ||
      (att.totalBytes != null && att.totalBytes > maxBytesOverride))
  ) {
    return Promise.resolve(null);
  }
  const retryOwner =
    isRcsAttachment(att) && mode === 'manual'
      ? beginRcsRetry(key, scope.generation, destinationIdentity)
      : undefined;
  return runDownload(att, scope, ownerFetcher, mode, onVerifiedBytes, maxBytesOverride, retryOwner);
}

/**
 * Replace a damaged local image/video without unlinking bytes that mounted native readers still
 * own. The new file is reserved and verified under a distinct UUID name, then the DB commit swaps
 * only the exact captured old path. Ordinary cache retirement cleans the old path after every
 * reader and outgoing fallback releases it.
 */
export function redownload(
  att: AttachmentRow,
  deliveryLease: RealtimeDeliveryLease,
): Promise<string | null> {
  const ownerFetcher = attachmentFetcherForInvocation();
  const scope = downloadScope(deliveryLease, ownerFetcher, att);
  const key = retryKey(att.guid, scope);
  const expectedLocalPath = att.localPath;
  const destinationIdentity = attachmentDownloadDestinationIdentity({
    expectedLocalPath: expectedLocalPath ?? '',
  });
  if (hasIncompatibleRcsOwner(key, destinationIdentity)) return Promise.resolve(null);
  if (
    !scope.isCurrent() ||
    !isLocalFileUri(expectedLocalPath) ||
    att.guid.startsWith('temp-') ||
    !attachmentMetadataAllowsDownload(att.totalBytes, 'manual')
  ) {
    cancelRcsRetry(key);
    if (scope.isCurrent()) useDownloadStore.getState().fail(att.guid);
    return Promise.resolve(null);
  }

  let oldPathProtection: ReturnType<typeof attachmentCacheCoordinator.protect> = null;
  try {
    oldPathProtection = attachmentCacheCoordinator.protect(expectedLocalPath);
  } catch {
    // Persisted paths are untrusted. A malformed path is unavailable, never a deletion target.
  }
  if (!oldPathProtection) {
    cancelRcsRetry(key);
    useDownloadStore.getState().fail(att.guid);
    return Promise.resolve(null);
  }

  let replacement: AttachmentDownloadReplacement;
  try {
    replacement = {
      expectedLocalPath,
      destinationName: `redownload-${Crypto.randomUUID()}${replacementFileExtension(att)}`,
    };
  } catch {
    cancelRcsRetry(key);
    oldPathProtection.release();
    useDownloadStore.getState().fail(att.guid);
    return Promise.resolve(null);
  }

  // Acquire the fresh owner's exact-path pin before retiring the previous RCS owner. Reversing
  // this order creates a brief zero-owner window where cache retirement can claim the damaged
  // source while the shared native replacement is still in flight.
  cancelRcsRetry(key);
  let retryOwner: symbol | undefined;
  let task: Promise<string | null>;
  try {
    retryOwner = isRcsAttachment(att)
      ? beginRcsRetry(key, scope.generation, destinationIdentity, oldPathProtection.release)
      : undefined;
    task = runDownload(
      att,
      scope,
      ownerFetcher,
      'manual',
      undefined,
      undefined,
      retryOwner,
      replacement,
    );
  } catch (error) {
    // `runDownload` reads the DB and starts Zustand presentation synchronously before returning its
    // Promise. A startup/disconnect exception must not strand the old-file pin or RCS owner.
    cancelRcsRetry(key, retryOwner);
    oldPathProtection.release();
    return Promise.reject(error);
  }
  if (retryOwner === undefined) return task.finally(oldPathProtection.release);
  return task
    .catch((error: unknown) => {
      cancelRcsRetry(key, retryOwner);
      throw error;
    })
    .finally(() => {
      // A sleeping RCS chain keeps the pin. Every terminal cancel path releases it.
      if (!ownsRcsRetry(key, retryOwner)) oldPathProtection.release();
    });
}

function downloadScope(
  lease: RealtimeDeliveryLease,
  ownerFetcher: AttachmentFetcher,
  att: Pick<AttachmentRow, 'guid' | 'service'>,
): AttachmentDownloadScope {
  const isCurrent = (): boolean =>
    lease.isCurrent() && (!isRcsAttachment(att) || sessionAccessors.acceptsRcsAttachment(att.guid));
  const cacheScope: AttachmentCacheReservationScope = {
    generation: lease.generation,
    isCurrent,
    runTracked: (task) => runTrackedDownloadWork(lease, task),
  };
  return {
    generation: lease.generation,
    isCurrent,
    runCommit: async (task) => {
      let persisted = false;
      const delivery = await runTrackedRealtimeWork(lease, async () => {
        persisted = await task();
      });
      return delivery === 'delivered' ? persisted : null;
    },
    ...(ownerFetcher.destinationUri
      ? {
          reserveCache: (path: string, maxBytes: number) =>
            isAttachmentCacheRecoveryReady(lease)
              ? attachmentCacheCoordinator.reserve(getDatabase(), {
                  path,
                  maxBytes,
                  scope: cacheScope,
                })
              : Promise.resolve({ status: 'storage' as const }),
          reuseCache: (path: string) =>
            isAttachmentCacheRecoveryReady(lease)
              ? attachmentCacheCoordinator.reuseExisting(getDatabase(), {
                  path,
                  scope: cacheScope,
                })
              : Promise.resolve({ status: 'busy' as const }),
        }
      : {}),
  };
}

function isRcsAttachment(att: Pick<AttachmentRow, 'guid' | 'service'>): boolean {
  return att.service === 'RCS' || att.guid.startsWith('rcs-media-');
}

/** Track one short account-owned task without opening a DB transaction of its own. */
async function runTrackedDownloadWork<T>(
  lease: RealtimeDeliveryLease,
  task: () => Promise<T>,
): Promise<T | null> {
  let outcome: { value: T } | undefined;
  const delivery = await runTrackedRealtimeWork(lease, async () => {
    outcome = { value: await task() };
  });
  return delivery === 'delivered' && outcome !== undefined ? outcome.value : null;
}

const retryKey = (guid: string, scope: AttachmentDownloadScope): string =>
  `${scope.generation}:${guid}`;

function beginRcsRetry(
  key: string,
  generation: number,
  destinationIdentity: string,
  releaseProtection?: () => void,
): symbol {
  const owner = Symbol(key);
  const state: RcsRetryState = {
    owner,
    destinationIdentity,
    retries: 0,
    timer: null,
    unsubscribeInvalidation: () => undefined,
    releaseProtection: releaseProtection ?? null,
  };
  rcsRetryStates.set(key, state);
  state.unsubscribeInvalidation = subscribeRealtimeGenerationInvalidation(generation, () => {
    cancelRcsRetry(key, owner);
  });
  return owner;
}

function hasIncompatibleRcsOwner(key: string, destinationIdentity: string): boolean {
  const current = rcsRetryStates.get(key);
  return current !== undefined && current.destinationIdentity !== destinationIdentity;
}

function cancelRcsRetry(key: string, owner?: symbol): void {
  const state = rcsRetryStates.get(key);
  if (!state || (owner !== undefined && state.owner !== owner)) return;
  if (state.timer != null) clearTimeout(state.timer);
  state.unsubscribeInvalidation();
  state.releaseProtection?.();
  state.releaseProtection = null;
  rcsRetryStates.delete(key);
}

function ownsRcsRetry(key: string, owner: symbol): boolean {
  return rcsRetryStates.get(key)?.owner === owner;
}

function runDownload(
  att: AttachmentRow,
  scope: AttachmentDownloadScope,
  ownerFetcher: AttachmentFetcher,
  mode: AttachmentDownloadMode,
  onVerifiedBytes?: (bytes: number) => void,
  maxBytesOverride?: number,
  retryOwner?: symbol,
  replacement?: AttachmentDownloadReplacement,
): Promise<string | null> {
  const key = retryKey(att.guid, scope);
  if (!scope.isCurrent()) {
    if (retryOwner !== undefined) cancelRcsRetry(key, retryOwner);
    return Promise.resolve(null);
  }
  if (retryOwner !== undefined && !ownsRcsRetry(key, retryOwner)) return Promise.resolve(null);
  const { start, setProgress, finish, fail } = useDownloadStore.getState();
  start(att.guid);
  return ensureDownloadedOutcome(
    getDatabase(),
    ownerFetcher,
    att,
    (loaded, total) => setProgress(att.guid, loaded, total),
    scope,
    mode,
    onVerifiedBytes,
    maxBytesOverride,
    replacement,
  ).then((outcome) => {
    // A fresh invocation may have superseded this chain while it shared an in-flight native
    // request. Only the current owner may schedule another timer or alter presentation state.
    if (retryOwner !== undefined && !ownsRcsRetry(key, retryOwner)) return null;
    if (!scope.isCurrent()) {
      if (retryOwner !== undefined) cancelRcsRetry(key, retryOwner);
      return null;
    }
    if (outcome.status === 'success') {
      if (retryOwner !== undefined) cancelRcsRetry(key, retryOwner);
      finish(att.guid);
      return outcome.localPath;
    }
    if (replacement && outcome.status === 'source_changed') {
      // Another owner already changed the authoritative DB row. This replacement lost safely;
      // publish a terminal marker so mounted observers reread and adopt that newer source instead
      // of retrying forever with the stale corrupt path.
      if (retryOwner !== undefined) cancelRcsRetry(key, retryOwner);
      finish(att.guid);
      return null;
    }
    if (retryOwner !== undefined && isTransientRcsOutcome(outcome)) {
      const state = rcsRetryStates.get(key);
      if (state?.owner === retryOwner && state.retries < MAX_RCS_RETRIES) {
        const n = state.retries;
        state.retries += 1;
        const delay = RCS_RETRY_BACKOFF_MS[Math.min(n, RCS_RETRY_BACKOFF_MS.length - 1)] ?? 12000;
        start(att.guid); // hold the spinner (not the reload button) through the backoff wait
        state.timer = setTimeout(() => {
          const current = rcsRetryStates.get(key);
          if (current?.owner !== retryOwner) return;
          current.timer = null;
          if (!scope.isCurrent()) {
            cancelRcsRetry(key, retryOwner);
            return;
          }
          void runDownload(
            att,
            scope,
            ownerFetcher,
            mode,
            onVerifiedBytes,
            maxBytesOverride,
            retryOwner,
            replacement,
          );
        }, delay);
        return null;
      }
      cancelRcsRetry(key, retryOwner);
    } else if (retryOwner !== undefined) {
      cancelRcsRetry(key, retryOwner);
    }
    fail(att.guid);
    return null;
  });
}

function isTransientRcsOutcome(outcome: AttachmentDownloadOutcome): boolean {
  return outcome.status === 'missing' || outcome.status === 'transient';
}
