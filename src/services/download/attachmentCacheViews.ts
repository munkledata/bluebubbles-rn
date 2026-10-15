import { logger } from '@core/secure';
import { getDatabase } from '@db/database';
import { isLocalFileUri } from '@utils';
import { captureRealtimeDeliveryLease } from '../realtime/deliveryCoordinator';
import { createAttachmentCacheAccountScope } from './attachmentCacheAccountScope';
import {
  ATTACHMENT_CACHE_ACCESS_TOUCH_INTERVAL_MS,
  attachmentCacheCoordinator,
} from './attachmentCacheCoordinator';
import { isAttachmentCacheRecoveryReady } from './attachmentCacheRecovery';

/** Views waiting to be recorded at once. A longer burst skips the rest; a later view retries. */
export const MAX_PENDING_ATTACHMENT_CACHE_VIEWS = 64;
/** Recently recorded files remembered so repeat views inside the interval cost nothing. */
const MAX_REMEMBERED_ATTACHMENT_CACHE_VIEWS = 512;

const recentViews = new Map<string, number>();
let pendingViews = 0;
let viewQueue: Promise<void> = Promise.resolve();

/**
 * Count a cached file shown on screen as used, so storage cleanup (least recently used first)
 * removes files nobody opens before the ones people keep looking at (review M145). A file's
 * last-used time used to change only when a download created or reused it; views only pinned the
 * file in memory.
 *
 * Best effort and bounded: each file is recorded at most once per touch interval per account,
 * records run one at a time, and views beyond the waiting limit are skipped. Recording goes
 * through the coordinator's reviewed reuse path, so a file found missing is repaired exactly as a
 * download would repair it. The returned promise never rejects.
 */
export function recordAttachmentCacheView(path: string): Promise<void> {
  if (!isLocalFileUri(path)) return Promise.resolve();
  const lease = captureRealtimeDeliveryLease();
  if (!isAttachmentCacheRecoveryReady(lease)) return Promise.resolve();
  const key = `${lease.generation}:${path}`;
  const now = Date.now();
  const recordedAt = recentViews.get(key);
  if (
    recordedAt !== undefined &&
    now >= recordedAt &&
    now - recordedAt < ATTACHMENT_CACHE_ACCESS_TOUCH_INTERVAL_MS
  ) {
    return Promise.resolve();
  }
  if (pendingViews >= MAX_PENDING_ATTACHMENT_CACHE_VIEWS) return Promise.resolve();
  rememberView(key, now);
  pendingViews += 1;
  const scope = createAttachmentCacheAccountScope(lease);
  const record = viewQueue.then(async () => {
    try {
      await attachmentCacheCoordinator.reuseExisting(getDatabase(), { path, scope });
    } catch (error) {
      logger.warn('[download] could not record a cached file view', {
        error: error instanceof Error ? error.name : typeof error,
      });
    } finally {
      pendingViews -= 1;
    }
  });
  viewQueue = record;
  return record;
}

function rememberView(key: string, at: number): void {
  recentViews.delete(key);
  recentViews.set(key, at);
  if (recentViews.size <= MAX_REMEMBERED_ATTACHMENT_CACHE_VIEWS) return;
  const oldest = recentViews.keys().next();
  if (!oldest.done) recentViews.delete(oldest.value);
}
