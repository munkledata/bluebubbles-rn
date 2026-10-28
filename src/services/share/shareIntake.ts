import { logger, shareIntakeEventOutcome, type ShareIntakeHeldAge } from '@core/secure';
import {
  acknowledgeNativeShareBatch,
  discardNativeShareBatch,
  discardNativeShareBatchForAccountReset,
  releaseNativeShareBatch,
  subscribeNativeShareIntake,
  takeNextNativeShareBatch,
  UnreadableNativeShareBatchError,
} from '@native/shareIntake';
import {
  admitShareIntakeTextDraftWithinTransaction,
  deleteShareIntakeReceipt,
  discardShareIntakeItemWithinTransaction,
  getShareIntakeReceipt,
  isShareIntakeNewChatRetryWindowOpen as repositoryShareIntakeNewChatRetryWindowOpen,
  isShareIntakeReceiptComplete as repositoryShareIntakeReceiptComplete,
  listShareIntakeReceiptBatchIds,
  prepareShareIntakeNewChatPlanWithinTransaction,
  shareIntakeFileItemKey,
  type ShareIntakeManifestIdentity,
  type ShareIntakeNewChatPlan,
  type ShareIntakeReceipt,
} from '@db/repositories';
import { getDatabase } from '@db/database';
import { withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { useShareIntentStore } from '@state/shareIntentStore';
import {
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';

let drainPromise: Promise<void> | null = null;
/** Set by any pull that should record finding nothing; foreground re-checks stay quiet. */
let recordEmptyPull = false;
let wakeGeneration = 0;
let handledWakeGeneration = 0;
let attemptedWakeGeneration = 0;

/** Account owner captured synchronously by the screen before any native or database await. */
export interface ShareIntakeSettlementOptions {
  /** Test/bootstrap injection; UI callers deliberately leave database ownership in this service. */
  readonly db?: AppDatabase;
  readonly lease: RealtimeDeliveryLease;
  readonly drainNext?: boolean;
}

function settlementDatabase(options: ShareIntakeSettlementOptions): AppDatabase {
  return options.db ?? getDatabase();
}

/** Read one encrypted receipt without exposing the raw database handle to a route or component. */
export function readShareIntakeReceipt(
  identity: ShareIntakeManifestIdentity,
): Promise<ShareIntakeReceipt | null> {
  return getShareIntakeReceipt(getDatabase(), identity);
}

/** Pure receipt predicate kept behind the service boundary used by share UI. */
export function isShareIntakeReceiptComplete(receipt: ShareIntakeReceipt): boolean {
  return repositoryShareIntakeReceiptComplete(receipt);
}

/** Pure retry-window predicate kept behind the service boundary used by new-chat UI. */
export function isShareIntakeNewChatRetryWindowOpen(
  identity: ShareIntakeManifestIdentity,
  nowMs = Date.now(),
): boolean {
  return repositoryShareIntakeNewChatRetryWindowOpen(identity, nowMs);
}

/** True when the durable receipt has already settled one exact native file ordinal. */
export function isShareIntakeFileSettled(
  receipt: ShareIntakeReceipt | null,
  itemIndex: number,
): boolean {
  return receipt?.items[shareIntakeFileItemKey(itemIndex)] != null;
}

/** Atomically mark one native item discarded while retaining database ownership in services. */
export function discardShareIntakeItem(
  args: {
    readonly identity: ShareIntakeManifestIdentity;
    readonly chatGuid?: string;
    readonly itemIndex: number;
    readonly appliedAtMs: number;
  },
  commitGuard?: DbCommitGuard,
): Promise<void> {
  return withDbTransaction(
    getDatabase(),
    (context) =>
      discardShareIntakeItemWithinTransaction(context, {
        identity: args.identity,
        ...(args.chatGuid === undefined ? {} : { chatGuid: args.chatGuid }),
        itemKey: shareIntakeFileItemKey(args.itemIndex),
        appliedAtMs: args.appliedAtMs,
      }),
    commitGuard,
  );
}

/** Merge shared text into an existing-chat draft and receipt in one guarded commit. */
export function admitShareIntakeTextDraft(
  args: {
    readonly identity: ShareIntakeManifestIdentity;
    readonly chatGuid: string;
    readonly sharedText: string;
    readonly draftKey: string;
    readonly appliedAtMs: number;
  },
  commitGuard?: DbCommitGuard,
): Promise<{ readonly draft: string; readonly alreadyApplied: boolean }> {
  return withDbTransaction(
    getDatabase(),
    (context) => admitShareIntakeTextDraftWithinTransaction(context, args),
    commitGuard,
  );
}

/** Freeze one exact new-chat replay plan before any network side effect begins. */
export function prepareShareIntakeNewChatPlan(
  identity: ShareIntakeManifestIdentity,
  plan: ShareIntakeNewChatPlan,
  commitGuard?: DbCommitGuard,
): Promise<ShareIntakeNewChatPlan> {
  return withDbTransaction(
    getDatabase(),
    (context) => prepareShareIntakeNewChatPlanWithinTransaction(context, identity, plan),
    commitGuard,
  );
}

function noteWake(): void {
  wakeGeneration += 1;
}

/** How long ago a share was made, as the coarse bucket the `share.intake` event keeps. */
export function shareIntakeHeldAge(createdAtMs: number, nowMs = Date.now()): ShareIntakeHeldAge {
  // A clock set back gives a negative age, which reads as just made.
  const ageMs = nowMs - createdAtMs;
  if (ageMs < 60_000) return 'under-1m';
  if (ageMs < 10 * 60_000) return 'under-10m';
  if (ageMs < 60 * 60_000) return 'under-1h';
  if (ageMs < 24 * 60 * 60_000) return 'under-24h';
  return 'over-24h';
}

/** Counts that describe the share held in the app right now, never its content. */
function heldShareCounts(): { files: number; text: boolean; held?: ShareIntakeHeldAge } {
  const state = useShareIntentStore.getState();
  return {
    files: state.files.length,
    text: state.text !== null,
    ...(state.createdAtMs == null ? {} : { held: shareIntakeHeldAge(state.createdAtMs) }),
  };
}

/**
 * On return to the foreground. With no share held, pull again: a missed signal or a failed pickup
 * leaves native shares waiting with nothing else to wake the app. With one held, record it, and ask
 * the navigator to open it again when no screen shows it.
 */
export function noteShareIntakeForeground(): void {
  const state = useShareIntentStore.getState();
  if (state.batchId === null) {
    void drainShareIntake({ quiet: true });
    return;
  }
  logger.event('share.intake', { stage: 'held', outcome: 'foreground', ...heldShareCounts() });
  if (state.owners === 0) state.requestReroute();
}

let lastDiscardedUnreadableBatchId: string | null = null;

/**
 * A claimed batch this build cannot read stays first in line and would block every later share
 * (M169). Tell the user, discard it by its exact id, and pull again. No database work: the drain
 * runs before login and above App Lock. Neither a failed discard nor the same id coming back after
 * a reported discard pulls again, so this cannot loop.
 */
async function settleUnreadableNativeBatch(batchId: string | null): Promise<void> {
  useShareIntentStore.getState().setFailureReason('malformed');
  if (batchId === null || batchId === lastDiscardedUnreadableBatchId) return;
  try {
    await discardNativeShareBatch(batchId);
  } catch (error: unknown) {
    logger.warn('[share] unreadable native batch could not be discarded', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return;
  }
  lastDiscardedUnreadableBatchId = batchId;
  noteWake();
}

function startDrainIfIdle(): Promise<void> {
  if (drainPromise) return drainPromise;
  const currentDrain = (async () => {
    while (useShareIntentStore.getState().batchId === null) {
      const observedWake = wakeGeneration;
      attemptedWakeGeneration = observedWake;
      const batch = await takeNextNativeShareBatch();
      handledWakeGeneration = observedWake;
      if (batch) {
        recordEmptyPull = false;
        useShareIntentStore.getState().stageIfEmpty(batch);
        logger.event('share.intake', {
          stage: 'pickup',
          outcome: 'staged',
          files: batch.files.length,
          text: batch.text !== null,
        });
        return;
      }
      if (observedWake === wakeGeneration) {
        if (recordEmptyPull) logger.event('share.intake', { stage: 'pickup', outcome: 'none' });
        recordEmptyPull = false;
        return;
      }
    }
  })()
    .catch(async (error: unknown) => {
      recordEmptyPull = false;
      handledWakeGeneration = Math.max(handledWakeGeneration, attemptedWakeGeneration);
      logger.warn('[share] completed native batch could not be staged', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      logger.event('share.intake', {
        stage: 'pickup',
        outcome: error instanceof UnreadableNativeShareBatchError ? 'unreadable' : 'failed',
      });
      if (error instanceof UnreadableNativeShareBatchError) {
        await settleUnreadableNativeBatch(error.batchId);
      } else {
        // Shown once the protected tree is visible; the next return to the foreground pulls again.
        useShareIntentStore.getState().setFailureReason('pickup');
      }
    })
    .finally(() => {
      drainPromise = null;
      // An event can arrive after the final empty check but before this callback. Its call saw the
      // still-live promise, so this finalizer must start the missed pull without inventing a wake.
      if (
        useShareIntentStore.getState().batchId === null &&
        handledWakeGeneration < wakeGeneration
      ) {
        void startDrainIfIdle();
      }
    });
  drainPromise = currentDrain;
  return currentDrain;
}

/**
 * Stage at most the one exact native claim; loop if an event races any empty-pull boundary. A
 * `quiet` pull (the foreground re-check) does not record finding nothing.
 */
export function drainShareIntake(options: { readonly quiet?: boolean } = {}): Promise<void> {
  noteWake();
  if (useShareIntentStore.getState().batchId !== null) {
    // The app takes one share at a time; a later one waits in native storage.
    logger.event('share.intake', { stage: 'pickup', outcome: 'held', ...heldShareCounts() });
  } else if (options.quiet !== true) {
    // Only a pull that will run sets this; the pull clears it however it ends.
    recordEmptyPull = true;
  }
  return startDrainIfIdle();
}

/** Subscribe above App Lock before the cold-start pull so no completion wake can be lost. */
export function startShareIntake(): () => void {
  const unsubscribe = subscribeNativeShareIntake(
    ({ newShare }) => {
      logger.event('share.intake', { stage: 'signal', outcome: 'received' });
      const state = useShareIntentStore.getState();
      // Only a newly committed share counts: settling the held share also signals the next one,
      // and that signal arrives before the held share is cleared here.
      if (newShare && state.batchId !== null) {
        // Native keeps the newer share. Say so, and open the held one again if nothing shows it.
        state.noteWaitingShare();
        if (state.owners === 0) state.requestReroute();
      }
      void drainShareIntake();
    },
    (reason) => {
      logger.warn('[share] native intake rejected', { reason });
      logger.event('share.intake', { stage: 'reject', outcome: shareIntakeEventOutcome(reason) });
      useShareIntentStore.getState().setFailureReason(reason);
    },
  );
  void drainShareIntake();
  return unsubscribe;
}

/** Acknowledge native storage only after the encrypted receipt proves every manifest item owned. */
export async function consumeShareIntakeBatchIfComplete(
  identity: ShareIntakeManifestIdentity,
  options: ShareIntakeSettlementOptions,
): Promise<boolean> {
  const db = settlementDatabase(options);
  let consumed = false;
  const outcome = await runTrackedRealtimeWork(options.lease, async () => {
    const receipt = await getShareIntakeReceipt(db, identity);
    if (!receipt || !repositoryShareIntakeReceiptComplete(receipt)) return;
    await acknowledgeNativeShareBatch(identity.batchId);
    await deleteShareIntakeReceipt(db, identity.batchId).catch((error: unknown) => {
      logger.warn('[share] acknowledged receipt cleanup deferred', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    });
    consumed = true;
    const cleared = useShareIntentStore.getState().clearIf(identity.batchId);
    if (cleared && options.drainNext !== false && options.lease.isCurrent()) {
      await drainShareIntake();
    }
  });
  if (consumed) logger.event('share.intake', { stage: 'settle', outcome: 'acknowledged' });
  return outcome === 'delivered' && consumed;
}

/** Return an abandoned composer claim to the native queue without deleting its content. */
export async function releaseShareIntakeBatch(
  batchId: string,
  options: ShareIntakeSettlementOptions,
): Promise<boolean> {
  let cleared = false;
  const outcome = await runTrackedRealtimeWork(options.lease, async () => {
    await releaseNativeShareBatch(batchId);
    cleared = useShareIntentStore.getState().clearIf(batchId);
    if (cleared && options.drainNext !== false && options.lease.isCurrent()) {
      await drainShareIntake();
    }
  });
  if (outcome === 'delivered')
    logger.event('share.intake', { stage: 'settle', outcome: 'released' });
  return outcome === 'delivered' && cleared;
}

/**
 * Explicit user discard is the only pre-send path allowed to delete a complete batch. The one
 * exception is a claim this build cannot read at all (settleUnreadableNativeBatch, M169).
 */
export async function discardShareIntakeBatch(
  batchId: string,
  options: ShareIntakeSettlementOptions,
): Promise<boolean> {
  const db = settlementDatabase(options);
  let cleared = false;
  const outcome = await runTrackedRealtimeWork(options.lease, async () => {
    await discardNativeShareBatch(batchId);
    await deleteShareIntakeReceipt(db, batchId).catch((error: unknown) => {
      logger.warn('[share] discarded receipt cleanup deferred', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    });
    cleared = useShareIntentStore.getState().clearIf(batchId);
    if (cleared && options.drainNext !== false && options.lease.isCurrent()) {
      await drainShareIntake();
    }
  });
  if (outcome === 'delivered')
    logger.event('share.intake', { stage: 'settle', outcome: 'discarded' });
  return outcome === 'delivered' && cleared;
}

/**
 * Disconnect boundary: a partially adopted native batch must not outlive its encrypted account
 * receipt and replay under the next account. Entirely unbound pre-login shares have no receipt and
 * deliberately survive this sweep.
 */
export async function discardAccountBoundShareIntake(db: AppDatabase): Promise<void> {
  const batchIds = await listShareIntakeReceiptBatchIds(db);
  for (const batchId of batchIds) {
    await discardNativeShareBatchForAccountReset(batchId);
    logger.event('share.intake', { stage: 'settle', outcome: 'account-reset' });
  }
  const activeBatchId = useShareIntentStore.getState().batchId;
  if (activeBatchId && batchIds.includes(activeBatchId)) {
    useShareIntentStore.getState().clear();
    await drainShareIntake();
  }
}
