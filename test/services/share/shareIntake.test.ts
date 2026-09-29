jest.mock('@native/shareIntake', () => ({
  takeNextNativeShareBatch: jest.fn(),
  acknowledgeNativeShareBatch: jest.fn(),
  releaseNativeShareBatch: jest.fn(),
  discardNativeShareBatch: jest.fn(),
  discardNativeShareBatchForAccountReset: jest.fn(),
  subscribeNativeShareIntake: jest.fn(),
}));

jest.mock('@db/database', () => ({
  getDatabase: jest.fn(() => ({ kind: 'service-owned-test-db' })),
}));

jest.mock('@db/repositories', () => ({
  admitShareIntakeTextDraftWithinTransaction: jest.fn(),
  deleteShareIntakeReceipt: jest.fn(() => Promise.resolve()),
  discardShareIntakeItemWithinTransaction: jest.fn(),
  getShareIntakeReceipt: jest.fn(),
  isShareIntakeNewChatRetryWindowOpen: jest.fn(),
  isShareIntakeReceiptComplete: jest.fn(),
  listShareIntakeReceiptBatchIds: jest.fn(),
  prepareShareIntakeNewChatPlanWithinTransaction: jest.fn(),
  shareIntakeFileItemKey: jest.fn((index: number) => `file:${String(index).padStart(2, '0')}`),
}));

jest.mock('@core/secure', () => ({
  logger: { warn: jest.fn() },
}));

// eslint-disable-next-line import/first
import { logger } from '@core/secure';
// eslint-disable-next-line import/first
import {
  acknowledgeNativeShareBatch,
  discardNativeShareBatch,
  discardNativeShareBatchForAccountReset,
  releaseNativeShareBatch,
  subscribeNativeShareIntake,
  takeNextNativeShareBatch,
} from '@native/shareIntake';
// eslint-disable-next-line import/first
import {
  deleteShareIntakeReceipt,
  getShareIntakeReceipt,
  isShareIntakeReceiptComplete,
  listShareIntakeReceiptBatchIds,
} from '@db/repositories';
// eslint-disable-next-line import/first
import {
  consumeShareIntakeBatch,
  consumeShareIntakeBatchIfComplete,
  discardAccountBoundShareIntake,
  discardShareIntakeBatch,
  drainShareIntake,
  releaseShareIntakeBatch,
  startShareIntake,
} from '@/services/share/shareIntake';
// eslint-disable-next-line import/first
import { useShareIntentStore } from '@state/shareIntentStore';
// eslint-disable-next-line import/first
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';

const takeNext = takeNextNativeShareBatch as jest.MockedFunction<typeof takeNextNativeShareBatch>;
const acknowledge = acknowledgeNativeShareBatch as jest.MockedFunction<
  typeof acknowledgeNativeShareBatch
>;
const release = releaseNativeShareBatch as jest.MockedFunction<typeof releaseNativeShareBatch>;
const discard = discardNativeShareBatch as jest.MockedFunction<typeof discardNativeShareBatch>;
const discardForAccountReset = discardNativeShareBatchForAccountReset as jest.MockedFunction<
  typeof discardNativeShareBatchForAccountReset
>;
const deleteReceipt = deleteShareIntakeReceipt as jest.MockedFunction<
  typeof deleteShareIntakeReceipt
>;
const getReceipt = getShareIntakeReceipt as jest.MockedFunction<typeof getShareIntakeReceipt>;
const isReceiptComplete = isShareIntakeReceiptComplete as jest.MockedFunction<
  typeof isShareIntakeReceiptComplete
>;
const listReceiptBatchIds = listShareIntakeReceiptBatchIds as jest.MockedFunction<
  typeof listShareIntakeReceiptBatchIds
>;
const subscribe = subscribeNativeShareIntake as jest.MockedFunction<
  typeof subscribeNativeShareIntake
>;
const warn = logger.warn as jest.MockedFunction<typeof logger.warn>;

const FIRST_BATCH = '1720000000000-1-0123456789abcdef';
const SECOND_BATCH = '1720000000001-2-fedcba9876543210';
const ACCOUNT_A_DB = { kind: 'account-a-db' } as never;
let accountLease: RealtimeDeliveryLease;

function settlementOptions(options: { readonly drainNext?: boolean } = {}) {
  return { db: ACCOUNT_A_DB, lease: accountLease, ...options };
}

function batch(batchId: string, text: string) {
  return {
    batchId,
    createdAtMs: 1_720_000_000_000,
    text,
    targetToken: null,
    files: [],
  };
}

function stageFirstBatch(): void {
  useShareIntentStore.getState().stageIfEmpty(batch(FIRST_BATCH, 'first'));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  accountLease = captureRealtimeDeliveryLease();
  useShareIntentStore.setState({
    batchId: null,
    createdAtMs: null,
    text: null,
    files: [],
    targetToken: null,
    failureReason: null,
  });
  takeNext.mockReset().mockResolvedValue(null);
  acknowledge.mockReset().mockResolvedValue(undefined);
  release.mockReset().mockResolvedValue(undefined);
  discard.mockReset().mockResolvedValue(undefined);
  discardForAccountReset.mockReset().mockResolvedValue(undefined);
  deleteReceipt.mockReset().mockResolvedValue(undefined);
  getReceipt.mockReset().mockResolvedValue(null);
  isReceiptComplete.mockReset().mockReturnValue(false);
  listReceiptBatchIds.mockReset().mockResolvedValue([]);
  subscribe.mockReset().mockReturnValue(jest.fn());
  warn.mockReset();
});

describe('share intake draining', () => {
  it('stages one exact native claim and stops before taking another', async () => {
    takeNext.mockResolvedValueOnce(batch(FIRST_BATCH, 'shared text'));

    await expect(drainShareIntake()).resolves.toBeUndefined();

    expect(takeNext).toHaveBeenCalledTimes(1);
    expect(useShareIntentStore.getState()).toMatchObject({
      batchId: FIRST_BATCH,
      text: 'shared text',
    });
  });

  it('coalesces simultaneous drains onto one native claim', async () => {
    const pendingTake = deferred<ReturnType<typeof batch> | null>();
    takeNext.mockReturnValueOnce(pendingTake.promise);

    const first = drainShareIntake();
    const second = drainShareIntake();

    expect(second).toBe(first);
    expect(takeNext).toHaveBeenCalledTimes(1);

    pendingTake.resolve(batch(FIRST_BATCH, 'shared text'));
    await first;
    expect(useShareIntentStore.getState().batchId).toBe(FIRST_BATCH);
  });

  it('rechecks native intake when a completion wake races an empty pull', async () => {
    const emptyPull = deferred<null>();
    takeNext
      .mockReturnValueOnce(emptyPull.promise)
      .mockResolvedValueOnce(batch(FIRST_BATCH, 'arrived during pull'));

    const drain = drainShareIntake();
    const racedWake = drainShareIntake();
    emptyPull.resolve(null);

    await expect(racedWake).resolves.toBeUndefined();
    await drain;
    expect(takeNext).toHaveBeenCalledTimes(2);
    expect(useShareIntentStore.getState()).toMatchObject({
      batchId: FIRST_BATCH,
      text: 'arrived during pull',
    });
  });

  it('restarts when a completion wake lands after the final empty check but before cleanup', async () => {
    const emptyPull = deferred<null>();
    // Register first so this reaction runs before the service resumes its `await`. The nested
    // microtask then fires only after that resumed body has accepted the null result and returned,
    // while the promise finalizer still owns `drainPromise` -- the narrow lost-wakeup window.
    void emptyPull.promise.then(() => {
      queueMicrotask(() => void drainShareIntake());
    });
    takeNext
      .mockReturnValueOnce(emptyPull.promise)
      .mockResolvedValueOnce(batch(FIRST_BATCH, 'arrived during finalization'));

    const drain = drainShareIntake();
    emptyPull.resolve(null);

    await drain;
    expect(takeNext).toHaveBeenCalledTimes(2);
    expect(useShareIntentStore.getState()).toMatchObject({
      batchId: FIRST_BATCH,
      text: 'arrived during finalization',
    });
  });

  it('does not pull another native batch while a composer owns one', async () => {
    stageFirstBatch();

    await drainShareIntake();

    expect(takeNext).not.toHaveBeenCalled();
    expect(useShareIntentStore.getState().batchId).toBe(FIRST_BATCH);
  });

  it('contains and redacts a native drain failure', async () => {
    takeNext.mockRejectedValueOnce(new TypeError('private native detail'));

    await expect(drainShareIntake()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('[share] completed native batch could not be staged', {
      errorName: 'TypeError',
    });
    expect(useShareIntentStore.getState().batchId).toBeNull();
  });
});

describe('share intake startup and failure receipts', () => {
  it('subscribes before the cold-start pull and stores reason-only rejection receipts', async () => {
    let onPending!: () => void;
    let onRejected!: (reason: string) => void;
    const unsubscribe = jest.fn();
    subscribe.mockImplementationOnce((pending, rejected) => {
      onPending = pending;
      onRejected = rejected;
      rejected('cache_quota');
      return unsubscribe;
    });

    const stop = startShareIntake();
    await drainShareIntake();

    expect(subscribe.mock.invocationCallOrder[0]).toBeLessThan(
      takeNext.mock.invocationCallOrder[0]!,
    );
    expect(useShareIntentStore.getState().failureReason).toBe('cache_quota');
    expect(warn).toHaveBeenCalledWith('[share] native intake rejected', {
      reason: 'cache_quota',
    });

    takeNext.mockResolvedValueOnce(batch(FIRST_BATCH, 'event-driven'));
    onPending();
    await drainShareIntake();
    expect(useShareIntentStore.getState().batchId).toBe(FIRST_BATCH);

    onRejected('permission');
    expect(useShareIntentStore.getState().failureReason).toBe('permission');
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('share intake exact-batch settlement', () => {
  it('acknowledges only after the encrypted receipt is complete', async () => {
    const identity = {
      batchId: FIRST_BATCH,
      nativeCreatedAtMs: 1_720_000_000_000,
      hasText: true,
      fileCount: 0,
    };
    getReceipt.mockResolvedValueOnce({} as Awaited<ReturnType<typeof getShareIntakeReceipt>>);
    await expect(consumeShareIntakeBatchIfComplete(identity, settlementOptions())).resolves.toBe(
      false,
    );
    expect(acknowledge).not.toHaveBeenCalled();

    getReceipt.mockResolvedValueOnce({} as Awaited<ReturnType<typeof getShareIntakeReceipt>>);
    isReceiptComplete.mockReturnValueOnce(true);
    await expect(consumeShareIntakeBatchIfComplete(identity, settlementOptions())).resolves.toBe(
      true,
    );
    expect(getReceipt).toHaveBeenLastCalledWith(ACCOUNT_A_DB, identity);
    expect(acknowledge).toHaveBeenCalledWith(FIRST_BATCH);
  });

  it.each([
    ['acknowledgement', consumeShareIntakeBatch, acknowledge],
    ['discard', discardShareIntakeBatch, discard],
  ])(
    'keeps native %s and captured-database receipt cleanup inside the account teardown barrier',
    async (_label, settle, nativeSettle) => {
      stageFirstBatch();
      const nativeGate = deferred<void>();
      const receiptGate = deferred<void>();
      nativeSettle.mockReturnValueOnce(nativeGate.promise);
      deleteReceipt.mockImplementationOnce(async (db) => {
        expect(db).toBe(ACCOUNT_A_DB);
        await receiptGate.promise;
      });

      const settlement = settle(FIRST_BATCH, settlementOptions());
      expect(nativeSettle).toHaveBeenCalledWith(FIRST_BATCH);

      let teardownSettled = false;
      const teardown = pauseRealtimeDeliveries().then(() => {
        teardownSettled = true;
      });
      await Promise.resolve();
      expect(teardownSettled).toBe(false);

      nativeGate.resolve(undefined);
      await Promise.resolve();
      await Promise.resolve();
      expect(deleteReceipt).toHaveBeenCalledWith(ACCOUNT_A_DB, FIRST_BATCH);
      expect(teardownSettled).toBe(false);

      receiptGate.resolve(undefined);
      await expect(settlement).resolves.toBe(true);
      await teardown;
      expect(teardownSettled).toBe(true);
      expect(takeNext).not.toHaveBeenCalled();
    },
  );

  it('rejects a settlement owned by a retired account before touching native or database state', async () => {
    const retiredOptions = settlementOptions({ drainNext: false });
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();

    await expect(discardShareIntakeBatch(FIRST_BATCH, retiredOptions)).resolves.toBe(false);

    expect(discard).not.toHaveBeenCalled();
    expect(deleteReceipt).not.toHaveBeenCalled();
  });

  it('discards every account-bound native batch before database teardown', async () => {
    stageFirstBatch();
    listReceiptBatchIds.mockResolvedValueOnce([FIRST_BATCH, SECOND_BATCH]);

    await discardAccountBoundShareIntake({ kind: 'test-db' } as never);

    expect(discardForAccountReset.mock.calls).toEqual([[FIRST_BATCH], [SECOND_BATCH]]);
    expect(useShareIntentStore.getState().batchId).toBeNull();
  });

  it.each([
    ['acknowledges', consumeShareIntakeBatch, acknowledge],
    ['releases', releaseShareIntakeBatch, release],
    ['discards', discardShareIntakeBatch, discard],
  ])(
    '%s the exact batch, clears it, then stages the next claim',
    async (_label, settle, nativeSettle) => {
      stageFirstBatch();
      takeNext.mockResolvedValueOnce(batch(SECOND_BATCH, 'second'));

      await expect(settle(FIRST_BATCH, settlementOptions())).resolves.toBe(true);

      expect(nativeSettle).toHaveBeenCalledWith(FIRST_BATCH);
      expect(useShareIntentStore.getState()).toMatchObject({
        batchId: SECOND_BATCH,
        text: 'second',
      });
    },
  );

  it.each([
    ['acknowledge', consumeShareIntakeBatch, acknowledge],
    ['release', releaseShareIntakeBatch, release],
    ['discard', discardShareIntakeBatch, discard],
  ])(
    'preserves the active claim when asked to %s a different batch',
    async (_label, settle, nativeSettle) => {
      stageFirstBatch();

      await expect(settle(SECOND_BATCH, settlementOptions())).resolves.toBe(false);

      expect(nativeSettle).toHaveBeenCalledWith(SECOND_BATCH);
      expect(useShareIntentStore.getState()).toMatchObject({
        batchId: FIRST_BATCH,
        text: 'first',
      });
      expect(takeNext).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['acknowledgement', consumeShareIntakeBatch, acknowledge],
    ['release', releaseShareIntakeBatch, release],
    ['discard', discardShareIntakeBatch, discard],
  ])('keeps the JS claim when native %s fails', async (_label, settle, nativeSettle) => {
    stageFirstBatch();
    const error = new Error('native ownership was not settled');
    nativeSettle.mockRejectedValueOnce(error);

    await expect(settle(FIRST_BATCH, settlementOptions())).rejects.toBe(error);

    expect(useShareIntentStore.getState()).toMatchObject({
      batchId: FIRST_BATCH,
      text: 'first',
    });
    expect(takeNext).not.toHaveBeenCalled();
  });
});
