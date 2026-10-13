import { logger } from '@core/secure';
import {
  acknowledgeNativeShareBatch,
  discardNativeShareBatch,
  discardNativeShareBatchForAccountReset,
  releaseNativeShareBatch,
  subscribeNativeShareIntake,
  takeNextNativeShareBatch,
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

function startDrainIfIdle(): Promise<void> {
  if (drainPromise) return drainPromise;
  const currentDrain = (async () => {
    while (useShareIntentStore.getState().batchId === null) {
      const observedWake = wakeGeneration;
      attemptedWakeGeneration = observedWake;
      const batch = await takeNextNativeShareBatch();
      handledWakeGeneration = observedWake;
      if (batch) {
        useShareIntentStore.getState().stageIfEmpty(batch);
        return;
      }
      if (observedWake === wakeGeneration) return;
    }
  })()
    .catch((error: unknown) => {
      handledWakeGeneration = Math.max(handledWakeGeneration, attemptedWakeGeneration);
      logger.warn('[share] completed native batch could not be staged', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
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

/** Stage at most the one exact native claim; loop if an event races any empty-pull boundary. */
export function drainShareIntake(): Promise<void> {
  noteWake();
  return startDrainIfIdle();
}

/** Subscribe above App Lock before the cold-start pull so no completion wake can be lost. */
export function startShareIntake(): () => void {
  const unsubscribe = subscribeNativeShareIntake(
    () => void drainShareIntake(),
    (reason) => {
      logger.warn('[share] native intake rejected', { reason });
      useShareIntentStore.getState().setFailureReason(reason);
    },
  );
  void drainShareIntake();
  return unsubscribe;
}

/** Finalize only the exact batch whose content now has durable outgoing ownership. */
export async function consumeShareIntakeBatch(
  batchId: string,
  options: ShareIntakeSettlementOptions,
): Promise<boolean> {
  const db = settlementDatabase(options);
  let cleared = false;
  const outcome = await runTrackedRealtimeWork(options.lease, async () => {
    await acknowledgeNativeShareBatch(batchId);
    await deleteShareIntakeReceipt(db, batchId).catch((error: unknown) => {
      logger.warn('[share] acknowledged receipt cleanup deferred', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    });
    cleared = useShareIntentStore.getState().clearIf(batchId);
    if (cleared && options.drainNext !== false && options.lease.isCurrent()) {
      await drainShareIntake();
    }
  });
  return outcome === 'delivered' && cleared;
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
  return outcome === 'delivered' && cleared;
}

/** Explicit user discard is the only pre-send path allowed to delete a complete batch. */
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
  }
  const activeBatchId = useShareIntentStore.getState().batchId;
  if (activeBatchId && batchIds.includes(activeBatchId)) {
    useShareIntentStore.getState().clear();
    await drainShareIntake();
  }
}
