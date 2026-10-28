type NativeEvent = 'onPending' | 'onRejected';
type NativeListener = (event: { reason?: unknown; newShare?: unknown }) => void;

const listeners = new Map<NativeEvent, NativeListener>();
const native = {
  takeNext: jest.fn(),
  acknowledge: jest.fn(),
  release: jest.fn(),
  discard: jest.fn(),
  discardForAccountReset: jest.fn(),
  takeLastError: jest.fn(),
  addListener: jest.fn((event: NativeEvent, listener: NativeListener) => {
    listeners.set(event, listener);
    return { remove: () => listeners.delete(event) };
  }),
};
const moduleRef: { current: typeof native | null } = { current: native };

jest.mock('expo', () => ({
  requireOptionalNativeModule: () => moduleRef.current,
}));

// Relative import deliberately exercises the adapter instead of a native Jest mapper.
// eslint-disable-next-line import/first
import {
  acknowledgeNativeShareBatch,
  discardNativeShareBatch,
  discardNativeShareBatchForAccountReset,
  parseNativeShareBatch,
  releaseNativeShareBatch,
  subscribeNativeShareIntake,
  takeNextNativeShareBatch,
  UnreadableNativeShareBatchError,
} from '../../src/native/shareIntake';

const BATCH_ID = '1720000000000-1-0123456789abcdef';
const OTHER_BATCH_ID = '1720000000001-2-fedcba9876543210';
const TARGET_TOKEN = `gator-share-v2-${'A'.repeat(43)}`;

function sharedFile(
  index: number,
  name: string,
  size: number,
  batchId: string = BATCH_ID,
): Record<string, unknown> {
  return {
    uri: `file:///data/user/0/gator/cache/shared-in/files/${batchId}/${String(index).padStart(2, '0')}-${name}`,
    name,
    mimeType: name.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg',
    size,
  };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    batchId: BATCH_ID,
    createdAtMs: 1_720_000_000_000,
    text: null,
    targetToken: null,
    files: [sharedFile(0, 'photo.jpg', 42)],
    ...overrides,
  };
}

beforeEach(() => {
  moduleRef.current = native;
  listeners.clear();
  native.takeNext.mockReset().mockResolvedValue(null);
  native.acknowledge.mockReset().mockResolvedValue(true);
  native.release.mockReset().mockResolvedValue(true);
  native.discard.mockReset().mockResolvedValue(true);
  native.discardForAccountReset.mockReset().mockResolvedValue(true);
  native.takeLastError.mockReset().mockReturnValue(null);
  native.addListener.mockClear();
});

describe('native share manifest validation', () => {
  it('accepts one complete app-private batch and marks its files as share-owned', () => {
    expect(
      parseNativeShareBatch(
        manifest({
          text: 'caption',
          targetToken: TARGET_TOKEN,
          files: [sharedFile(0, 'photo.jpg', 42), sharedFile(1, 'document.pdf', 84)],
        }),
      ),
    ).toEqual({
      batchId: BATCH_ID,
      createdAtMs: 1_720_000_000_000,
      text: 'caption',
      targetToken: TARGET_TOKEN,
      files: [
        {
          uri: `file:///data/user/0/gator/cache/shared-in/files/${BATCH_ID}/00-photo.jpg`,
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          size: 42,
          origin: 'share',
          shareItemIndex: 0,
        },
        {
          uri: `file:///data/user/0/gator/cache/shared-in/files/${BATCH_ID}/01-document.pdf`,
          name: 'document.pdf',
          mimeType: 'application/pdf',
          size: 84,
          origin: 'share',
          shareItemIndex: 1,
        },
      ],
    });
  });

  it('accepts a bounded text-only share', () => {
    expect(parseNativeShareBatch(manifest({ text: 'shared text', files: [] }))).toMatchObject({
      batchId: BATCH_ID,
      text: 'shared text',
      files: [],
    });
  });

  // Exact messages, so a case cannot pass by failing for an unrelated reason (review M009).
  const BATCH = 'invalid share batch';
  const FILE = 'invalid shared file';
  const ESCAPED = 'shared file escaped its native batch';
  const TEXT = 'shared text is too large';

  it.each([
    ['a non-object', null, BATCH],
    ['an invalid batch id', manifest({ batchId: '../batch' }), BATCH],
    ['a non-integer timestamp', manifest({ createdAtMs: 1.5 }), BATCH],
    ['missing explicit nullable text', manifest({ text: undefined }), BATCH],
    ['an invalid target token', manifest({ targetToken: 'conversation-guid' }), BATCH],
    ['an empty batch', manifest({ text: null, files: [] }), BATCH],
    ['oversized UTF-8 text', manifest({ text: 'é'.repeat(32_769), files: [] }), TEXT],
    [
      'too many files',
      manifest({ files: Array.from({ length: 11 }, (_, i) => sharedFile(i, `p${i}.jpg`, 1)) }),
      BATCH,
    ],
    ['a zero-byte file', manifest({ files: [sharedFile(0, 'empty.jpg', 0)] }), FILE],
    [
      'an oversized file',
      manifest({ files: [sharedFile(0, 'huge.jpg', 128 * 1024 * 1024 + 1)] }),
      FILE,
    ],
    [
      'aggregate bytes over the batch limit',
      manifest({
        files: [
          sharedFile(0, 'a.jpg', 128 * 1024 * 1024),
          sharedFile(1, 'b.jpg', 128 * 1024 * 1024),
          sharedFile(2, 'c.jpg', 128 * 1024 * 1024),
          sharedFile(3, 'd.jpg', 128 * 1024 * 1024),
          sharedFile(4, 'e.jpg', 1),
        ],
      }),
      BATCH,
    ],
    [
      'a file outside the exact batch directory',
      manifest({ files: [sharedFile(0, 'photo.jpg', 42, OTHER_BATCH_ID)] }),
      ESCAPED,
    ],
    [
      'a mismatched native file index',
      manifest({ files: [{ ...sharedFile(1, 'photo.jpg', 42) }] }),
      ESCAPED,
    ],
    [
      'an unsafe filename',
      manifest({
        files: [
          {
            ...sharedFile(0, 'photo.jpg', 42),
            name: '../photo.jpg',
          },
        ],
      }),
      FILE,
    ],
    [
      'an invalid MIME type',
      manifest({
        files: [{ ...sharedFile(0, 'photo.jpg', 42), mimeType: 'IMAGE/JPEG' }],
      }),
      FILE,
    ],
  ])('rejects %s with its own error', (_label, value, message) => {
    expect(() => parseNativeShareBatch(value)).toThrow(new Error(message));
  });
});

describe('native share exact-claim bridge', () => {
  it('takes and validates the next native claim', async () => {
    native.takeNext.mockResolvedValueOnce(manifest({ text: 'hello', files: [] }));

    await expect(takeNextNativeShareBatch()).resolves.toMatchObject({
      batchId: BATCH_ID,
      text: 'hello',
    });
    expect(native.takeNext).toHaveBeenCalledTimes(1);
  });

  it('reports an unreadable claim with its exact batch id so it can be discarded', async () => {
    native.takeNext.mockResolvedValueOnce(
      manifest({ files: [sharedFile(0, '../escape.jpg', 42)] }),
    );

    const error = await takeNextNativeShareBatch().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnreadableNativeShareBatchError);
    expect(error).toMatchObject({
      name: 'UnreadableNativeShareBatchError',
      batchId: BATCH_ID,
    });
  });

  it.each([
    ['an invalid id', manifest({ batchId: '../not-a-batch', createdAtMs: 'soon' })],
    ['no object at all', 42],
  ])('reports an unreadable claim with %s without a batch id', async (_label, value) => {
    native.takeNext.mockResolvedValueOnce(value);

    const error = await takeNextNativeShareBatch().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnreadableNativeShareBatchError);
    expect(error).toMatchObject({ batchId: null });
  });

  it('returns null when no native batch or optional module exists', async () => {
    await expect(takeNextNativeShareBatch()).resolves.toBeNull();

    moduleRef.current = null;
    await expect(takeNextNativeShareBatch()).resolves.toBeNull();
  });

  it.each([
    ['acknowledges', acknowledgeNativeShareBatch, native.acknowledge],
    ['releases', releaseNativeShareBatch, native.release],
    ['discards', discardNativeShareBatch, native.discard],
  ])('%s only the exact validated batch id', async (_label, operation, nativeOperation) => {
    await expect(operation(BATCH_ID)).resolves.toBeUndefined();
    expect(nativeOperation).toHaveBeenCalledWith(BATCH_ID);

    await expect(operation('not-a-batch')).rejects.toThrow('invalid share batch id');
    expect(nativeOperation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['acknowledgement', acknowledgeNativeShareBatch, native.acknowledge],
    ['release', releaseNativeShareBatch, native.release],
    ['discard', discardNativeShareBatch, native.discard],
  ])(
    'fails closed when native %s does not confirm ownership',
    async (label, operation, nativeOperation) => {
      nativeOperation.mockResolvedValueOnce(false);
      await expect(operation(BATCH_ID)).rejects.toThrow(`share batch ${label} failed`);

      moduleRef.current = null;
      await expect(operation(BATCH_ID)).rejects.toThrow(`share batch ${label} failed`);
    },
  );

  it('idempotently discards an exact account-bound batch during account reset', async () => {
    await expect(discardNativeShareBatchForAccountReset(BATCH_ID)).resolves.toBeUndefined();
    expect(native.discardForAccountReset).toHaveBeenCalledWith(BATCH_ID);

    await expect(discardNativeShareBatchForAccountReset('not-a-batch')).rejects.toThrow(
      'invalid share batch id',
    );
    expect(native.discardForAccountReset).toHaveBeenCalledTimes(1);
  });

  it('fails closed when native account-reset cleanup cannot prove completion', async () => {
    native.discardForAccountReset.mockResolvedValueOnce(false);
    await expect(discardNativeShareBatchForAccountReset(BATCH_ID)).rejects.toThrow(
      'account-bound share batch cleanup failed',
    );

    moduleRef.current = null;
    await expect(discardNativeShareBatchForAccountReset(BATCH_ID)).rejects.toThrow(
      'account-bound share batch cleanup failed',
    );
  });
});

describe('native share completion and rejection notifications', () => {
  it('subscribes before consuming the persisted failure receipt and removes both listeners', () => {
    const onPending = jest.fn();
    const onRejected = jest.fn();
    native.takeLastError.mockReturnValueOnce('deadline');

    const unsubscribe = subscribeNativeShareIntake(onPending, onRejected);

    expect(native.addListener.mock.calls.map(([event]) => event)).toEqual([
      'onPending',
      'onRejected',
    ]);
    expect(native.addListener.mock.invocationCallOrder[1]).toBeLessThan(
      native.takeLastError.mock.invocationCallOrder[0]!,
    );
    expect(onRejected).toHaveBeenCalledWith('deadline');

    listeners.get('onPending')?.({ newShare: true });
    listeners.get('onPending')?.({ newShare: false });
    listeners.get('onPending')?.({});
    listeners.get('onPending')?.({ newShare: 'true' });
    listeners.get('onRejected')?.({ reason: 'permission' });
    listeners.get('onRejected')?.({ reason: 123 });
    // Only a literal true marks a newly committed share; anything else is a reminder.
    expect(onPending.mock.calls).toEqual([
      [{ newShare: true }],
      [{ newShare: false }],
      [{ newShare: false }],
      [{ newShare: false }],
    ]);
    expect(onRejected).toHaveBeenNthCalledWith(2, 'permission');
    expect(onRejected).toHaveBeenNthCalledWith(3, 'unavailable');

    unsubscribe();
    expect(listeners.size).toBe(0);
  });

  it('consumes the persisted receipt of a live rejection so the next launch does not repeat it', () => {
    const onRejected = jest.fn();
    subscribeNativeShareIntake(jest.fn(), onRejected);
    expect(native.takeLastError).toHaveBeenCalledTimes(1);

    // Native records the same rejection in memory and on disk before emitting it.
    native.takeLastError.mockReturnValueOnce('too-many-items');
    listeners.get('onRejected')?.({ reason: 'too-many-items' });

    expect(native.takeLastError).toHaveBeenCalledTimes(2);
    expect(native.takeLastError.mock.invocationCallOrder[1]).toBeLessThan(
      onRejected.mock.invocationCallOrder[0]!,
    );
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(onRejected).toHaveBeenCalledWith('too-many-items');
  });

  it('still reports a live rejection when its receipt cannot be consumed', () => {
    const onRejected = jest.fn();
    subscribeNativeShareIntake(jest.fn(), onRejected);
    native.takeLastError.mockImplementationOnce(() => {
      throw new Error('native unavailable');
    });

    listeners.get('onRejected')?.({ reason: 'deadline' });

    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(onRejected).toHaveBeenCalledWith('deadline');
  });

  it('is a safe no-op when the optional native module is absent', () => {
    moduleRef.current = null;
    const onPending = jest.fn();
    const onRejected = jest.fn();

    const unsubscribe = subscribeNativeShareIntake(onPending, onRejected);
    unsubscribe();

    expect(native.addListener).not.toHaveBeenCalled();
    expect(onPending).not.toHaveBeenCalled();
    expect(onRejected).not.toHaveBeenCalled();
  });
});
