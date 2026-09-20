import { logger } from '@core/secure';
import { getDatabase } from '@db/database';
import { rebuildInboxSearchIndexBatch } from '@db/repositories/inboxSearchIndex';
import {
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';

/**
 * Warm the optional inbox-name candidate index after an authenticated account is published.
 * Every short batch is separately admitted to the teardown barrier and yields before the next;
 * an old account cannot keep writing while Disconnect clears its rows. A search can restart a
 * completed pass after later chat/contact changes; dirty rows remain exact-searchable meanwhile.
 */
const MAX_INBOX_INDEX_BATCHES_PER_PASS = 2000;
const INBOX_INDEX_CONTINUATION_DELAY_MS = 5000;
let inboxIndexTail: Promise<void> = Promise.resolve();
const inboxIndexFlights = new Map<number, Promise<void>>();

function scheduleInboxSearchIndexContinuation(lease: RealtimeDeliveryLease): void {
  let unsubscribe = (): void => undefined;
  const timer = setTimeout(() => {
    unsubscribe();
    if (lease.isCurrent()) void runInboxSearchIndexRebuildOnce(lease);
  }, INBOX_INDEX_CONTINUATION_DELAY_MS);
  unsubscribe = subscribeRealtimeGenerationInvalidation(lease.generation, () => {
    clearTimeout(timer);
    unsubscribe();
  });
}

async function runInboxSearchIndexRebuildPass(lease: RealtimeDeliveryLease): Promise<void> {
  try {
    if (!lease.isCurrent()) return;
    const db = getDatabase();
    let afterChatId = 0;
    let settled = 0;
    let deferred = 0;
    for (let batchNumber = 0; batchNumber < MAX_INBOX_INDEX_BATCHES_PER_PASS; batchNumber += 1) {
      if (!lease.isCurrent()) return;
      let batch: Awaited<ReturnType<typeof rebuildInboxSearchIndexBatch>> | null = null;
      const status = await runTrackedRealtimeWork(lease, async (activeLease) => {
        batch = await rebuildInboxSearchIndexBatch(db, afterChatId, () => activeLease.isCurrent());
      });
      if (status === 'paused' || !lease.isCurrent() || batch == null) return;
      const currentBatch: Awaited<ReturnType<typeof rebuildInboxSearchIndexBatch>> = batch;
      if (currentBatch.visited === 0) {
        if (afterChatId === 0) {
          if (settled > 0 || deferred > 0) {
            logger.info('[search] rebuilt inbox candidate index', { settled, deferred });
          }
          return;
        }
        afterChatId = 0;
        continue;
      }
      afterChatId = currentBatch.lastChatId;
      settled += currentBatch.settled;
      deferred += currentBatch.deferred;
      // A zero-delay timer yields to UI/sync and keeps this entire backlog out of one drain slot.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (lease.isCurrent()) {
      logger.info('[search] paused inbox index rebuild at batch budget', { settled, deferred });
      scheduleInboxSearchIndexContinuation(lease);
    }
  } catch (error) {
    if (lease.isCurrent()) logger.warn('[search] inbox index rebuild skipped', error);
  }
}

export function runInboxSearchIndexRebuildOnce(lease: RealtimeDeliveryLease): Promise<void> {
  const existing = inboxIndexFlights.get(lease.generation);
  if (existing) return existing;

  const attempt = inboxIndexTail.then(() => runInboxSearchIndexRebuildPass(lease));
  inboxIndexTail = attempt.catch(() => undefined);
  inboxIndexFlights.set(lease.generation, attempt);
  const clear = (): void => {
    if (inboxIndexFlights.get(lease.generation) === attempt) {
      inboxIndexFlights.delete(lease.generation);
    }
  };
  void attempt.then(clear, clear);
  return attempt;
}
