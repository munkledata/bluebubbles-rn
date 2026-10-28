jest.mock('@native/shareIntake', () => {
  // Mirrors the real bridge error, whose own contract is tested in test/native/shareIntake.test.ts.
  class UnreadableNativeShareBatchError extends Error {
    constructor(readonly batchId: string | null) {
      super('claimed share batch is unreadable');
      this.name = 'UnreadableNativeShareBatchError';
    }
  }
  return {
    takeNextNativeShareBatch: jest.fn(),
    acknowledgeNativeShareBatch: jest.fn(),
    releaseNativeShareBatch: jest.fn(),
    discardNativeShareBatch: jest.fn(),
    discardNativeShareBatchForAccountReset: jest.fn(),
    subscribeNativeShareIntake: jest.fn(),
    UnreadableNativeShareBatchError,
  };
});

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
  logger: { warn: jest.fn(), event: jest.fn() },
  shareIntakeEventOutcome: jest.requireActual('@core/secure/errorDiagnostic')
    .shareIntakeEventOutcome as (value: unknown) => string,
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
  UnreadableNativeShareBatchError,
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
  consumeShareIntakeBatchIfComplete,
  discardAccountBoundShareIntake,
  discardShareIntakeBatch,
  drainShareIntake,
  noteShareIntakeForeground,
  releaseShareIntakeBatch,
  shareIntakeHeldAge,
  startShareIntake,
} from '@/services/share/shareIntake';
// eslint-disable-next-line import/first
import { useShareIntentStore } from '@state/shareIntentStore';
// eslint-disable-next-line import/first
import {
  nextEventLoopTurn,
  waitForCondition,
  waitForMicrotaskCondition,
} from '../../support/async';
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
const event = logger.event as jest.MockedFunction<typeof logger.event>;

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
    owners: 0,
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
  event.mockReset();
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

  // M169: a claim this build cannot read would otherwise stay first in line and block every share.
  it('discards an unreadable claim by its exact id, reports it, and stages the next batch', async () => {
    takeNext
      .mockRejectedValueOnce(new UnreadableNativeShareBatchError(FIRST_BATCH))
      .mockResolvedValueOnce(batch(SECOND_BATCH, 'next share'));
    const failures: string[] = [];
    const unsubscribe = useShareIntentStore.subscribe((state, previous) => {
      if (state.failureReason && state.failureReason !== previous.failureReason) {
        failures.push(state.failureReason);
      }
    });

    await drainShareIntake();
    await waitForCondition(
      () => useShareIntentStore.getState().batchId === SECOND_BATCH,
      'the next batch staged',
    );
    unsubscribe();

    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith(FIRST_BATCH);
    expect(failures).toEqual(['malformed']);
    expect(takeNext).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('[share] completed native batch could not be staged', {
      errorName: 'UnreadableNativeShareBatchError',
    });
  });

  it('reports an unreadable claim once and stops when its discard fails', async () => {
    // Each unreadable-claim test uses its own id: a reported discard is remembered per process.
    const STUCK_BATCH = '1720000000003-4-0f1e2d3c4b5a6978';
    takeNext.mockRejectedValueOnce(new UnreadableNativeShareBatchError(STUCK_BATCH));
    discard.mockRejectedValueOnce(new Error('share batch discard failed'));

    await drainShareIntake();
    await waitForCondition(() => warn.mock.calls.length >= 2, 'the discard failure logged');
    await nextEventLoopTurn();

    expect(takeNext).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(useShareIntentStore.getState().failureReason).toBe('malformed');
    expect(warn).toHaveBeenCalledWith('[share] unreadable native batch could not be discarded', {
      errorName: 'Error',
    });
  });

  it('stops when the same unreadable claim comes back after a reported discard', async () => {
    const SAME_BATCH = '1720000000002-3-00112233aabbccdd';
    takeNext
      .mockRejectedValueOnce(new UnreadableNativeShareBatchError(SAME_BATCH))
      .mockRejectedValueOnce(new UnreadableNativeShareBatchError(SAME_BATCH))
      .mockResolvedValueOnce(batch(SECOND_BATCH, 'must not be reached'));

    await drainShareIntake();
    await waitForCondition(() => takeNext.mock.calls.length >= 2, 'the second pull');
    await nextEventLoopTurn();

    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith(SAME_BATCH);
    expect(takeNext).toHaveBeenCalledTimes(2);
    expect(useShareIntentStore.getState().batchId).toBeNull();
  });

  it('reports an unreadable claim without a valid id but cannot discard it', async () => {
    takeNext.mockRejectedValueOnce(new UnreadableNativeShareBatchError(null));

    await drainShareIntake();
    await nextEventLoopTurn();

    expect(discard).not.toHaveBeenCalled();
    expect(takeNext).toHaveBeenCalledTimes(1);
    expect(useShareIntentStore.getState().failureReason).toBe('malformed');
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

function identityFor(batchId: string) {
  return { batchId, nativeCreatedAtMs: 1_720_000_000_000, hasText: true, fileCount: 0 };
}

function receiptIsComplete(): void {
  getReceipt.mockResolvedValueOnce({} as Awaited<ReturnType<typeof getShareIntakeReceipt>>);
  isReceiptComplete.mockReturnValueOnce(true);
}

describe('share intake exact-batch settlement', () => {
  it('keeps native acknowledgement and receipt cleanup inside the account teardown barrier', async () => {
    stageFirstBatch();
    receiptIsComplete();
    const nativeGate = deferred<void>();
    const receiptGate = deferred<void>();
    acknowledge.mockReturnValueOnce(nativeGate.promise);
    deleteReceipt.mockImplementationOnce(async (db) => {
      expect(db).toBe(ACCOUNT_A_DB);
      await receiptGate.promise;
    });

    const settlement = consumeShareIntakeBatchIfComplete(
      identityFor(FIRST_BATCH),
      settlementOptions(),
    );
    await waitForMicrotaskCondition(() => acknowledge.mock.calls.length === 1, 'acknowledgement');
    expect(acknowledge).toHaveBeenCalledWith(FIRST_BATCH);

    let teardownSettled = false;
    const teardown = pauseRealtimeDeliveries().then(() => {
      teardownSettled = true;
    });
    await Promise.resolve();
    expect(teardownSettled).toBe(false);

    nativeGate.resolve(undefined);
    await waitForMicrotaskCondition(() => deleteReceipt.mock.calls.length === 1, 'receipt cleanup');
    expect(deleteReceipt).toHaveBeenCalledWith(ACCOUNT_A_DB, FIRST_BATCH);
    expect(teardownSettled).toBe(false);

    receiptGate.resolve(undefined);
    await expect(settlement).resolves.toBe(true);
    await teardown;
    expect(teardownSettled).toBe(true);
    expect(takeNext).not.toHaveBeenCalled();
  });

  it('acknowledges a complete batch, clears it, then stages the next claim', async () => {
    stageFirstBatch();
    receiptIsComplete();
    takeNext.mockResolvedValueOnce(batch(SECOND_BATCH, 'second'));

    await expect(
      consumeShareIntakeBatchIfComplete(identityFor(FIRST_BATCH), settlementOptions()),
    ).resolves.toBe(true);

    expect(acknowledge).toHaveBeenCalledWith(FIRST_BATCH);
    expect(useShareIntentStore.getState()).toMatchObject({ batchId: SECOND_BATCH, text: 'second' });
  });

  it('acknowledges a complete different batch without touching the active claim', async () => {
    stageFirstBatch();
    receiptIsComplete();

    // Success reflects native and receipt state, not which batch the composer happens to hold.
    await expect(
      consumeShareIntakeBatchIfComplete(identityFor(SECOND_BATCH), settlementOptions()),
    ).resolves.toBe(true);

    expect(acknowledge).toHaveBeenCalledWith(SECOND_BATCH);
    expect(useShareIntentStore.getState()).toMatchObject({ batchId: FIRST_BATCH, text: 'first' });
    expect(takeNext).not.toHaveBeenCalled();
  });

  it('keeps the JS claim and its receipt when native acknowledgement fails', async () => {
    stageFirstBatch();
    receiptIsComplete();
    const error = new Error('native ownership was not settled');
    acknowledge.mockRejectedValueOnce(error);

    await expect(
      consumeShareIntakeBatchIfComplete(identityFor(FIRST_BATCH), settlementOptions()),
    ).rejects.toBe(error);

    expect(deleteReceipt).not.toHaveBeenCalled();
    expect(useShareIntentStore.getState()).toMatchObject({ batchId: FIRST_BATCH, text: 'first' });
    expect(takeNext).not.toHaveBeenCalled();
  });

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

  it.each([['discard', discardShareIntakeBatch, discard]])(
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

describe('share intake diagnostic events', () => {
  const sharedFile = (index: number) => ({
    uri: `file:///data/shared-in/files/${FIRST_BATCH}/0${index}-private-photo.jpg`,
    name: 'private-photo.jpg',
    mimeType: 'image/jpeg',
    size: 1_000,
    origin: 'share' as const,
    shareItemIndex: index,
  });

  function shareEvents(): unknown[] {
    return event.mock.calls.filter(([code]) => code === 'share.intake').map(([, meta]) => meta);
  }

  it('records each pickup with counts only, and an empty pull as none', async () => {
    takeNext.mockResolvedValueOnce({
      ...batch(FIRST_BATCH, 'PRIVATE_SHARED_TEXT'),
      files: [sharedFile(0), sharedFile(1)],
    });
    await drainShareIntake();
    useShareIntentStore.getState().clearIf(FIRST_BATCH);
    await drainShareIntake();

    expect(shareEvents()).toEqual([
      { stage: 'pickup', outcome: 'staged', files: 2, text: true },
      { stage: 'pickup', outcome: 'none' },
    ]);
    expect(JSON.stringify(event.mock.calls)).not.toMatch(/PRIVATE|private-photo|1720000000000-1/);
  });

  it('records a pull asked for while a share is already held, with that share counts', async () => {
    stageFirstBatch();
    await drainShareIntake();

    expect(shareEvents()).toEqual([
      { stage: 'pickup', outcome: 'held', files: 0, text: true, held: 'over-24h' },
    ]);
    expect(takeNext).not.toHaveBeenCalled();
  });

  it('records a failed pickup and an unreadable claim apart', async () => {
    takeNext.mockRejectedValueOnce(new Error('bridge failed'));
    await drainShareIntake();
    takeNext.mockRejectedValueOnce(new UnreadableNativeShareBatchError(null));
    await drainShareIntake();

    expect(shareEvents()).toEqual([
      { stage: 'pickup', outcome: 'failed' },
      { stage: 'pickup', outcome: 'unreadable' },
    ]);
  });

  it('records the native signal and every rejection, mapping unknown reasons to unknown', async () => {
    let onPending: () => void = () => undefined;
    let onRejected: (reason: string) => void = () => undefined;
    subscribe.mockImplementationOnce((pending, rejected) => {
      onPending = pending;
      onRejected = rejected;
      return jest.fn();
    });
    const stop = startShareIntake();
    await nextEventLoopTurn();
    event.mockClear();

    onPending();
    await nextEventLoopTurn();
    onRejected('busy');
    onRejected('a reason with private words');
    stop();

    expect(shareEvents()).toEqual([
      { stage: 'signal', outcome: 'received' },
      { stage: 'pickup', outcome: 'none' },
      { stage: 'reject', outcome: 'busy' },
      { stage: 'reject', outcome: 'unknown' },
    ]);
  });

  it('records each settlement once it is done, and none when it fails', async () => {
    stageFirstBatch();
    // A receipt that is not complete yet acknowledges nothing, so it records nothing.
    await consumeShareIntakeBatchIfComplete(identityFor(FIRST_BATCH), settlementOptions());
    receiptIsComplete();
    await consumeShareIntakeBatchIfComplete(identityFor(FIRST_BATCH), settlementOptions());
    stageFirstBatch();
    await releaseShareIntakeBatch(FIRST_BATCH, settlementOptions({ drainNext: false }));
    stageFirstBatch();
    await discardShareIntakeBatch(FIRST_BATCH, settlementOptions({ drainNext: false }));
    listReceiptBatchIds.mockResolvedValueOnce([FIRST_BATCH, SECOND_BATCH]);
    await discardAccountBoundShareIntake(ACCOUNT_A_DB);
    stageFirstBatch();
    receiptIsComplete();
    acknowledge.mockRejectedValueOnce(new Error('native acknowledge failed'));
    await expect(
      consumeShareIntakeBatchIfComplete(identityFor(FIRST_BATCH), settlementOptions()),
    ).rejects.toThrow('native acknowledge failed');

    expect(shareEvents().filter((meta) => (meta as { stage: string }).stage === 'settle')).toEqual([
      { stage: 'settle', outcome: 'acknowledged' },
      { stage: 'settle', outcome: 'released' },
      { stage: 'settle', outcome: 'discarded' },
      { stage: 'settle', outcome: 'account-reset' },
      { stage: 'settle', outcome: 'account-reset' },
    ]);
  });

  it('notes a share still held on return to the foreground, and nothing otherwise', () => {
    noteShareIntakeForeground();
    expect(shareEvents()).toEqual([]);

    stageFirstBatch();
    noteShareIntakeForeground();
    expect(shareEvents()).toEqual([
      { stage: 'held', outcome: 'foreground', files: 0, text: true, held: 'over-24h' },
    ]);
  });

  it('buckets how long ago a share was made', () => {
    const made = 1_000_000_000_000;
    expect(shareIntakeHeldAge(made, made)).toBe('under-1m');
    expect(shareIntakeHeldAge(made, made + 59_999)).toBe('under-1m');
    expect(shareIntakeHeldAge(made, made + 60_000)).toBe('under-10m');
    expect(shareIntakeHeldAge(made, made + 10 * 60_000)).toBe('under-1h');
    expect(shareIntakeHeldAge(made, made + 60 * 60_000)).toBe('under-24h');
    expect(shareIntakeHeldAge(made, made + 24 * 60 * 60_000 - 1)).toBe('under-24h');
    expect(shareIntakeHeldAge(made, made + 24 * 60 * 60_000)).toBe('over-24h');
    // A clock set back makes the share look newer than now; it still reads as just made.
    expect(shareIntakeHeldAge(made + 5_000, made)).toBe('under-1m');
  });
});

describe('share intake recovery', () => {
  function captureNativeListeners(): { onPending: () => void } {
    const captured = { onPending: () => undefined as void };
    subscribe.mockImplementationOnce((pending) => {
      captured.onPending = pending;
      return jest.fn();
    });
    return captured;
  }

  it('pulls again on return to the foreground with nothing held, and stages what was waiting', async () => {
    takeNext.mockResolvedValueOnce(batch(FIRST_BATCH, 'waited'));

    noteShareIntakeForeground();
    await waitForCondition(
      () => useShareIntentStore.getState().batchId === FIRST_BATCH,
      'the waiting share staged',
    );

    expect(takeNext).toHaveBeenCalledTimes(1);
  });

  it('keeps a foreground pull that finds nothing out of the log, while a signal pull still records it', async () => {
    noteShareIntakeForeground();
    await waitForCondition(() => takeNext.mock.calls.length === 1, 'the quiet pull');
    await nextEventLoopTurn();
    expect(event).not.toHaveBeenCalled();

    await drainShareIntake();
    expect(event).toHaveBeenCalledWith('share.intake', { stage: 'pickup', outcome: 'none' });
  });

  it('does not let a pull asked for while a share is held make a later quiet pull record nothing found', async () => {
    stageFirstBatch();
    await drainShareIntake();
    useShareIntentStore.getState().clearIf(FIRST_BATCH);
    event.mockClear();

    noteShareIntakeForeground();
    await waitForCondition(() => takeNext.mock.calls.length === 1, 'the quiet pull');
    await nextEventLoopTurn();
    expect(event).not.toHaveBeenCalled();
  });

  it('asks to open the held share again on return to the foreground only when no screen shows it', () => {
    stageFirstBatch();
    const before = useShareIntentStore.getState().rerouteRequest;

    noteShareIntakeForeground();
    expect(useShareIntentStore.getState().rerouteRequest).toBe(before + 1);

    const release = useShareIntentStore.getState().adopt(FIRST_BATCH);
    noteShareIntakeForeground();
    expect(useShareIntentStore.getState().rerouteRequest).toBe(before + 1);
    release();
    expect(takeNext).not.toHaveBeenCalled();
  });

  it('says a newer share is waiting when a signal arrives while one is held', async () => {
    const native = captureNativeListeners();
    const stop = startShareIntake();
    await nextEventLoopTurn();
    const start = useShareIntentStore.getState();

    native.onPending();
    expect(useShareIntentStore.getState().waitingNotice).toBe(start.waitingNotice);

    stageFirstBatch();
    native.onPending();
    expect(useShareIntentStore.getState().waitingNotice).toBe(start.waitingNotice + 1);
    expect(useShareIntentStore.getState().rerouteRequest).toBe(start.rerouteRequest + 1);

    const release = useShareIntentStore.getState().adopt(FIRST_BATCH);
    native.onPending();
    expect(useShareIntentStore.getState().waitingNotice).toBe(start.waitingNotice + 2);
    expect(useShareIntentStore.getState().rerouteRequest).toBe(start.rerouteRequest + 1);
    release();
    stop();
  });

  it('reports a failed pickup and pulls again on the next return to the foreground', async () => {
    takeNext.mockRejectedValueOnce(new Error('bridge failed'));
    await drainShareIntake();
    expect(useShareIntentStore.getState().failureReason).toBe('pickup');

    takeNext.mockResolvedValueOnce(batch(FIRST_BATCH, 'second try'));
    noteShareIntakeForeground();
    await waitForCondition(
      () => useShareIntentStore.getState().batchId === FIRST_BATCH,
      'the retried pickup staged',
    );
  });

  it('reports an unreadable claim as malformed, not as a failed pickup', async () => {
    takeNext.mockRejectedValueOnce(new UnreadableNativeShareBatchError(null));
    await drainShareIntake();
    expect(useShareIntentStore.getState().failureReason).toBe('malformed');
  });
});
