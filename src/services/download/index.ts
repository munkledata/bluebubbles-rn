import { getDatabase } from '@db/database';
import type { AttachmentRow } from '@db/repositories';
import { useDownloadStore } from '@state/downloadStore';
import { http } from '../clients';
import {
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';
import {
  attachmentMetadataAllowsDownload,
  ensureDownloadedOutcome,
  type AttachmentDownloadMode,
  type AttachmentDownloadOutcome,
  type AttachmentDownloadScope,
  type AttachmentFetcher,
} from './downloadService';
import {
  attachmentCacheCoordinator,
  type AttachmentCacheReservationScope,
} from './attachmentCacheCoordinator';
import { isAttachmentCacheRecoveryReady } from './attachmentCacheRecovery';
import { expoFetcher } from './expoFetcher';

export type { AttachmentFetcher } from './downloadService';
export { ensureDownloaded } from './downloadService';

let fetcher: AttachmentFetcher = expoFetcher(http);

/** DEV/test hook to swap the fetcher (e.g. a real-URL progress stub). */
export function setAttachmentFetcher(f: AttachmentFetcher): void {
  // Metro defines __DEV__ in every app bundle; plain Node/Jest intentionally does not.
  if (typeof __DEV__ !== 'undefined' && !__DEV__) {
    throw new Error('Attachment fetcher replacement is development-only.');
  }
  fetcher = f;
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
  retries: number;
  timer: ReturnType<typeof setTimeout> | null;
  unsubscribeInvalidation: () => void;
}

/** One retry chain per account generation + attachment. */
const rcsRetryStates = new Map<string, RcsRetryState>();

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
  const scope = downloadScope(deliveryLease, fetcher);
  const key = retryKey(att.guid, scope);
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
    att.service === 'RCS' && mode === 'manual' ? beginRcsRetry(key, scope.generation) : undefined;
  return runDownload(att, scope, mode, onVerifiedBytes, maxBytesOverride, retryOwner);
}

function downloadScope(
  lease: RealtimeDeliveryLease,
  ownerFetcher: AttachmentFetcher,
): AttachmentDownloadScope {
  const cacheScope: AttachmentCacheReservationScope = {
    generation: lease.generation,
    isCurrent: () => lease.isCurrent(),
    runTracked: (task) => runTrackedDownloadWork(lease, task),
  };
  return {
    generation: lease.generation,
    isCurrent: () => lease.isCurrent(),
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

function beginRcsRetry(key: string, generation: number): symbol {
  const owner = Symbol(key);
  const state: RcsRetryState = {
    owner,
    retries: 0,
    timer: null,
    unsubscribeInvalidation: () => undefined,
  };
  rcsRetryStates.set(key, state);
  state.unsubscribeInvalidation = subscribeRealtimeGenerationInvalidation(generation, () => {
    cancelRcsRetry(key, owner);
  });
  return owner;
}

function cancelRcsRetry(key: string, owner?: symbol): void {
  const state = rcsRetryStates.get(key);
  if (!state || (owner !== undefined && state.owner !== owner)) return;
  if (state.timer != null) clearTimeout(state.timer);
  state.unsubscribeInvalidation();
  rcsRetryStates.delete(key);
}

function ownsRcsRetry(key: string, owner: symbol): boolean {
  return rcsRetryStates.get(key)?.owner === owner;
}

function runDownload(
  att: AttachmentRow,
  scope: AttachmentDownloadScope,
  mode: AttachmentDownloadMode,
  onVerifiedBytes?: (bytes: number) => void,
  maxBytesOverride?: number,
  retryOwner?: symbol,
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
    fetcher,
    att,
    (loaded, total) => setProgress(att.guid, loaded, total),
    scope,
    mode,
    onVerifiedBytes,
    maxBytesOverride,
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
          void runDownload(att, scope, mode, onVerifiedBytes, maxBytesOverride, retryOwner);
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
