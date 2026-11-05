import {
  ATTACHMENT_CACHE_RECOVERY_BATCH_FILES,
  ATTACHMENT_CACHE_RECOVERY_MAX_FILES,
} from '@db/repositories';
import {
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { ensureDatabase } from '../databaseControl';
import { createAttachmentCacheAccountScope } from './attachmentCacheAccountScope';
import { attachmentCacheCoordinator } from './attachmentCacheCoordinator';

/** One pass retires at most one 100-file batch; the ledger itself holds at most 8,192 files. */
const CHAT_DOWNLOAD_REMOVAL_MAX_PASSES =
  Math.ceil(ATTACHMENT_CACHE_RECOVERY_MAX_FILES / ATTACHMENT_CACHE_RECOVERY_BATCH_FILES) + 2;

export interface ChatDownloadRemovalResult {
  /** `stale`: the account changed part-way; whatever was already removed stays removed. */
  status: 'complete' | 'stale';
  /** Files deleted from the phone. */
  removed: number;
  /** Files whose delete failed; startup recovery retries them. */
  failed: number;
  /** Files kept because they were on screen, downloading, being sent or awaiting a Photos copy. */
  kept: number;
}

/**
 * "Remove this chat's downloaded files": delete the phone's copies of files ONLY this chat uses.
 * Messages are untouched and each file downloads again when tapped. Every pass goes through the
 * coordinator's ordinary retirement owner (short claim transaction, native delete outside it), and
 * the loop stops when a pass finds nothing more, the account changes, or the pass bound is reached.
 */
export async function removeChatDownloadedFiles(
  chatGuid: string,
  accountLease: RealtimeDeliveryLease,
): Promise<ChatDownloadRemovalResult> {
  const result: ChatDownloadRemovalResult = { status: 'stale', removed: 0, failed: 0, kept: 0 };
  const delivery = await runTrackedRealtimeWork(accountLease, async (activeLease) => {
    if (!activeLease.isCurrent()) return;
    const db = await ensureDatabase();
    if (!activeLease.isCurrent()) return;
    const scope = createAttachmentCacheAccountScope(activeLease);
    for (let pass = 0; pass < CHAT_DOWNLOAD_REMOVAL_MAX_PASSES; pass += 1) {
      const step = await attachmentCacheCoordinator.retireChatEntries(db, { chatGuid, scope });
      result.removed += step.confirmed;
      result.failed += step.failed;
      // Skipped files are offered again on every pass, so the last pass's count is the real one.
      result.kept = step.skipped;
      if (step.status === 'stale' || !activeLease.isCurrent()) return;
      if (step.attempted === 0) break;
    }
    result.status = 'complete';
  });
  if (delivery !== 'delivered') result.status = 'stale';
  return result;
}
