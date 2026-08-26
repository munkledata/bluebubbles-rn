/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
const getChat = jest.fn(async () => ({ guid: 'chat-1' }));
const persistServerChat = jest.fn(async () => undefined);
const getSyncedBackgroundState = jest.fn(
  async (): Promise<{ channel: string; uri: string | null }> => ({
    channel: 'channel-1',
    uri: null,
  }),
);
const setSyncedBackgroundUriIfCurrent = jest.fn(
  async (
    _db: AppDatabase,
    _guid: string,
    _channel: string | null,
    _previousUri: string | null,
    _nextUri: string | null,
  ) => true,
);
const getChatTheme = jest.fn(async () => null);
const setSyncedBackgroundLuminanceIfCurrent = jest.fn(async () => true);
const mockDbCommitGuardRejectedError = class DbCommitGuardRejectedError extends Error {};
const mockWithDbTransaction = jest.fn(
  async (
    _db: unknown,
    task: (context: object) => Promise<unknown>,
    commitGuard?: () => boolean,
  ) => {
    if (commitGuard && !commitGuard()) throw new mockDbCommitGuardRejectedError();
    const result = await task({});
    if (commitGuard && !commitGuard()) throw new mockDbCommitGuardRejectedError();
    return result;
  },
);
const mockComputeBackgroundIsLight = jest.fn(async () => false);
const mockFileBytes = new Map<string, number>();
const mockDeletedUris: string[] = [];
let mockLastFinalUri = '';
const mockPendingDownloads: Array<{
  destinationUri: string;
  finalUri: string;
  cancel: jest.Mock;
  resolve(bytes?: number, progressBytes?: number, totalBytes?: number): void;
}> = [];

jest.mock('@core/api', () => ({
  chatsApi: {
    getChat,
    chatBackgroundUrl: jest.fn(() => 'https://server.example/background'),
  },
}));
jest.mock('@db/repositories', () => ({
  persistServerChat,
  getSyncedBackgroundState,
  setSyncedBackgroundUriIfCurrentWithinTransaction: setSyncedBackgroundUriIfCurrent,
  getChatTheme,
  setSyncedBackgroundLuminanceIfCurrentWithinTransaction: setSyncedBackgroundLuminanceIfCurrent,
}));
jest.mock('@db/transaction', () => ({
  DbCommitGuardRejectedError: mockDbCommitGuardRejectedError,
  withDbTransaction: mockWithDbTransaction,
}));
jest.mock('@/services/backgrounds/luminance', () => ({
  computeBackgroundIsLight: mockComputeBackgroundIsLight,
}));
jest.mock('expo-file-system', () => ({
  Paths: { cache: '/cache', document: '/documents' },
  Directory: class {
    readonly uri: string;
    readonly exists = false;

    constructor(...parts: Array<string | { uri: string }>) {
      const [first, ...rest] = parts.map((part) => (typeof part === 'string' ? part : part.uri));
      this.uri = `${first?.replace(/\/$/, '') ?? ''}/${rest.join('/')}`;
    }

    create(): void {}
    delete(): void {}
  },
  File: class {
    static createDownloadTask(
      _url: string,
      destination: { uri: string },
      options: {
        signal: AbortSignal;
        onProgress: (progress: { bytesWritten: number; totalBytes: number }) => void;
      },
    ): {
      cancel: jest.Mock;
      release: jest.Mock;
      downloadAsync: () => Promise<{ uri: string }>;
    } {
      let rejectDownload: ((error: Error) => void) | undefined;
      const cancel = jest.fn(() => rejectDownload?.(new Error('native cancelled')));
      options.signal.addEventListener('abort', cancel);
      return {
        cancel,
        release: jest.fn(),
        downloadAsync: () =>
          new Promise((resolve, reject) => {
            rejectDownload = reject;
            mockPendingDownloads.push({
              destinationUri: destination.uri,
              finalUri: mockLastFinalUri,
              cancel,
              resolve: (bytes = 10, progressBytes = bytes, totalBytes = bytes) => {
                mockFileBytes.set(destination.uri, bytes);
                options.onProgress({ bytesWritten: progressBytes, totalBytes });
                resolve(destination);
              },
            });
          }),
      };
    }

    uri: string;

    constructor(directory: { uri: string } | string, name?: string) {
      const base = typeof directory === 'string' ? directory : directory.uri;
      this.uri = name == null ? base : `${base}/${name}`;
      if (!this.uri.includes('/bounded-download-parts/')) mockLastFinalUri = this.uri;
    }

    get exists(): boolean {
      return mockFileBytes.has(this.uri);
    }
    get size(): number {
      return mockFileBytes.get(this.uri) ?? 0;
    }
    delete(): void {
      mockDeletedUris.push(this.uri);
      mockFileBytes.delete(this.uri);
    }
    async move(destination: { uri: string }): Promise<void> {
      const bytes = mockFileBytes.get(this.uri);
      mockFileBytes.delete(this.uri);
      if (bytes != null) mockFileBytes.set(destination.uri, bytes);
      this.uri = destination.uri;
    }
  },
}));

import type { EventDeliveryContext } from '@core/realtime';
import { logger } from '@core/secure';
import type { AppDatabase } from '@db/types';
import {
  deleteNativeSyncedBackgroundCacheFile,
  pruneNativeSyncedBackgroundCache,
} from '@native/boundedDownload';
import {
  ensureSyncedBackground,
  SYNCED_BACKGROUND_CACHE_REPAIR_DELAY_MS,
  SYNCED_BACKGROUND_MAX_BYTES,
  SYNCED_BACKGROUND_MAX_CONCURRENT,
  SYNCED_BACKGROUND_TIMEOUT_MS,
} from '@/services/backgrounds/syncedBackground';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const mockPruneSyncedBackgroundCache = jest.mocked(pruneNativeSyncedBackgroundCache);
const mockDeleteSyncedBackgroundCacheFile = jest.mocked(deleteNativeSyncedBackgroundCacheFile);

beforeEach(() => {
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await pauseRealtimeDeliveries();
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
  mockFileBytes.clear();
  mockDeletedUris.length = 0;
  mockPendingDownloads.length = 0;
  mockLastFinalUri = '';
  jest.restoreAllMocks();
});

async function takePendingDownload(): Promise<(typeof mockPendingDownloads)[number]> {
  for (let i = 0; i < 20 && mockPendingDownloads.length === 0; i += 1) {
    await Promise.resolve();
  }
  const pending = mockPendingDownloads.shift();
  if (!pending) throw new Error('synced-background download did not start');
  return pending;
}

async function waitForPendingDownloads(count: number): Promise<void> {
  for (let i = 0; i < 50 && mockPendingDownloads.length < count; i += 1) {
    await Promise.resolve();
  }
  expect(mockPendingDownloads).toHaveLength(count);
}

function backgroundUri(generation: number, channel = 'channel-1'): string {
  const name = `media-${encodeURIComponent(JSON.stringify(['chat-1', channel]))}.jpg`;
  return `/documents/synced-backgrounds/generation-${generation}/${name}`;
}

describe('account-scoped synced backgrounds', () => {
  it('coalesces one chat and lets only the latest request persist refreshed metadata', async () => {
    const oldChat = { guid: 'chat-1' };
    const latestChat = { guid: 'chat-1' };
    let resolveOld!: (chat: typeof oldChat) => void;
    getChat
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(latestChat);
    getSyncedBackgroundState.mockResolvedValueOnce({ channel: '', uri: null });
    const context: EventDeliveryContext = { generation: 1, isCurrent: () => true };

    const first = ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      context,
    );
    for (let i = 0; i < 20 && getChat.mock.calls.length === 0; i += 1) await Promise.resolve();
    const latest = ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      context,
    );
    expect(latest).toBe(first);

    resolveOld(oldChat);
    await Promise.all([first, latest]);

    expect(getChat).toHaveBeenCalledTimes(2);
    expect(persistServerChat).toHaveBeenCalledTimes(1);
    const persisted = persistServerChat.mock.calls as unknown as Array<[AppDatabase, unknown]>;
    expect(persisted[0]?.[1]).toBe(latestChat);
  });

  it('collapses repeated same-chat triggers to one latest rerun and cleans superseded bytes', async () => {
    const context: EventDeliveryContext = { generation: 2, isCurrent: () => true };
    const first = ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      context,
    );
    const superseded = await takePendingDownload();
    const second = ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      context,
    );
    const latest = ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      context,
    );
    expect(second).toBe(first);
    expect(latest).toBe(first);

    superseded.resolve();
    const replacement = await takePendingDownload();
    replacement.resolve();
    await Promise.all([first, second, latest]);

    expect(getChat).toHaveBeenCalledTimes(2);
    expect(mockDeletedUris).toContain(superseded.destinationUri);
    expect(setSyncedBackgroundUriIfCurrent).toHaveBeenCalledTimes(1);
    expect(setSyncedBackgroundUriIfCurrent.mock.calls[0]?.[4]).toBe(replacement.finalUri);
  });

  it('deletes an uncommitted replacement but retains the referenced old file when channel validation loses', async () => {
    const previous = backgroundUri(4, 'old-channel');
    mockFileBytes.set(previous, 10);
    getSyncedBackgroundState.mockResolvedValueOnce({ channel: 'channel-1', uri: previous });
    setSyncedBackgroundUriIfCurrent.mockResolvedValueOnce(false);
    const run = ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      { generation: 4, isCurrent: () => true },
    );
    const pending = await takePendingDownload();
    pending.resolve();
    await run;

    expect(setSyncedBackgroundUriIfCurrent).toHaveBeenCalledWith(
      expect.anything(),
      'chat-1',
      'channel-1',
      previous,
      pending.finalUri,
    );
    expect(mockDeletedUris).toContain(pending.finalUri);
    expect(mockDeletedUris).not.toContain(previous);
    expect(mockDeleteSyncedBackgroundCacheFile).not.toHaveBeenCalledWith(previous);
    expect(setSyncedBackgroundLuminanceIfCurrent).not.toHaveBeenCalled();
  });

  it('prevents an older luminance calculation from writing after a newer same-chat call', async () => {
    const uri = backgroundUri(5);
    mockFileBytes.set(uri, 10);
    getSyncedBackgroundState
      .mockResolvedValueOnce({ channel: 'channel-1', uri })
      .mockResolvedValueOnce({ channel: 'channel-1', uri });
    let resolveOldLuminance!: (isLight: boolean) => void;
    mockComputeBackgroundIsLight.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldLuminance = resolve;
        }),
    );
    const context: EventDeliveryContext = { generation: 5, isCurrent: () => true };
    const first = ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      context,
    );
    for (let i = 0; i < 20 && mockComputeBackgroundIsLight.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    const latest = ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      context,
    );
    resolveOldLuminance(true);
    await Promise.all([first, latest]);

    expect(mockComputeBackgroundIsLight).toHaveBeenCalledTimes(2);
    expect(setSyncedBackgroundLuminanceIfCurrent).toHaveBeenCalledTimes(1);
    expect(setSyncedBackgroundLuminanceIfCurrent).toHaveBeenCalledWith(
      expect.anything(),
      'chat-1',
      'channel-1',
      uri,
      false,
    );
  });

  it('caps process-wide synced-background work across different chats', async () => {
    const runs = Array.from({ length: 5 }, (_unused, index) =>
      ensureSyncedBackground(
        {
          snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
        } as never,
        {} as AppDatabase,
        `chat-${index}`,
        { generation: 6, isCurrent: () => true },
      ),
    );

    await waitForPendingDownloads(SYNCED_BACKGROUND_MAX_CONCURRENT);
    expect(getChat).toHaveBeenCalledTimes(SYNCED_BACKGROUND_MAX_CONCURRENT);
    for (let completed = 0; completed < runs.length; completed += 1) {
      for (let i = 0; i < 50 && mockPendingDownloads.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(mockPendingDownloads.length).toBeGreaterThan(0);
      expect(mockPendingDownloads.length).toBeLessThanOrEqual(SYNCED_BACKGROUND_MAX_CONCURRENT);
      mockPendingDownloads.shift()!.resolve();
    }
    await Promise.all(runs);
    expect(getChat).toHaveBeenCalledTimes(runs.length);
  });

  it('deletes a wallpaper transfer that finishes after Disconnect revoked its generation', async () => {
    let current = true;
    const context: EventDeliveryContext = { generation: 3, isCurrent: () => current };
    const run = ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      context,
    );
    const pending = await takePendingDownload();

    current = false;
    pending.resolve();
    await run;

    expect(pending.finalUri).toBe(backgroundUri(3));
    expect(pending.destinationUri).toMatch(
      /^\/cache\/bounded-download-parts\/request-\d+-\d+\.part$/,
    );
    expect(pending.destinationUri).not.toBe(`${pending.finalUri}.part`);
    expect(mockDeletedUris).toContain(pending.destinationUri);
    expect(setSyncedBackgroundUriIfCurrent).not.toHaveBeenCalled();
    expect(setSyncedBackgroundLuminanceIfCurrent).not.toHaveBeenCalled();
  });

  it('uses distinct destinations for different account generations', async () => {
    const runForGeneration = async (generation: number): Promise<string> => {
      const context: EventDeliveryContext = { generation, isCurrent: () => true };
      const run = ensureSyncedBackground(
        {
          snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
        } as never,
        {} as AppDatabase,
        'chat-1',
        context,
      );
      const pending = await takePendingDownload();
      pending.resolve();
      await run;
      return pending.finalUri;
    };

    const first = await runForGeneration(11);
    const second = await runForGeneration(12);

    expect(first).toBe(backgroundUri(11));
    expect(second).toBe(backgroundUri(12));
    expect(first).not.toBe(second);
    expect(setSyncedBackgroundUriIfCurrent.mock.calls.map((call) => call[4])).toEqual([
      first,
      second,
    ]);
  });

  it('deletes the previous persistent wallpaper only after its replacement is committed', async () => {
    const previous = backgroundUri(13, 'old-channel');
    mockFileBytes.set(previous, 10);
    getSyncedBackgroundState.mockResolvedValueOnce({ channel: 'channel-1', uri: previous });
    const context: EventDeliveryContext = { generation: 13, isCurrent: () => true };
    const run = ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      context,
    );

    const pending = await takePendingDownload();
    expect(mockDeleteSyncedBackgroundCacheFile).not.toHaveBeenCalledWith(previous);
    pending.resolve();
    await run;

    expect(setSyncedBackgroundUriIfCurrent).toHaveBeenCalledWith(
      expect.anything(),
      'chat-1',
      'channel-1',
      previous,
      backgroundUri(13),
    );
    expect(mockDeleteSyncedBackgroundCacheFile).toHaveBeenCalledWith(previous);
  });

  it('deletes a canonical flat wallpaper left by the pre-quota layout after replacement', async () => {
    const previous = '/documents/synced-backgrounds/chat-guid-channel-guid.jpg';
    mockFileBytes.set(previous, 10);
    getSyncedBackgroundState.mockResolvedValueOnce({ channel: 'channel-1', uri: previous });
    const run = ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      { generation: 18, isCurrent: () => true },
    );

    const pending = await takePendingDownload();
    pending.resolve();
    await run;

    expect(mockDeleteSyncedBackgroundCacheFile).toHaveBeenCalledWith(previous);
  });

  it('prunes the global cache only after commit and protects the committed destination', async () => {
    const run = ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      { generation: 16, isCurrent: () => true },
    );
    const pending = await takePendingDownload();

    expect(mockPruneSyncedBackgroundCache).not.toHaveBeenCalled();
    pending.resolve();
    await run;

    expect(mockPruneSyncedBackgroundCache).toHaveBeenCalledWith(pending.finalUri);
    expect(setSyncedBackgroundUriIfCurrent.mock.invocationCallOrder[0]).toBeLessThan(
      mockPruneSyncedBackgroundCache.mock.invocationCallOrder[0]!,
    );
  });

  it('repairs a reported quota overage on a bounded delay', async () => {
    jest.useFakeTimers();
    try {
      mockPruneSyncedBackgroundCache
        .mockResolvedValueOnce({
          withinQuota: false,
          deletedFiles: 0,
          deletedBytes: 0,
          remainingFiles: 11,
          remainingBytes: 110,
        })
        .mockResolvedValueOnce({
          withinQuota: true,
          deletedFiles: 1,
          deletedBytes: 10,
          remainingFiles: 10,
          remainingBytes: 100,
        });
      const run = ensureSyncedBackground(
        {
          snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
        } as never,
        {} as AppDatabase,
        'chat-1',
        { generation: 17, isCurrent: () => true },
      );
      const pending = await takePendingDownload();
      pending.resolve();
      await run;

      expect(mockPruneSyncedBackgroundCache).toHaveBeenCalledTimes(1);
      expect(mockPruneSyncedBackgroundCache).toHaveBeenLastCalledWith(pending.finalUri);

      await jest.advanceTimersByTimeAsync(SYNCED_BACKGROUND_CACHE_REPAIR_DELAY_MS);
      expect(mockPruneSyncedBackgroundCache).toHaveBeenCalledTimes(2);
      expect(mockPruneSyncedBackgroundCache).toHaveBeenLastCalledWith(null);
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses its second bounded repair attempt after a transient native rejection', async () => {
    jest.useFakeTimers();
    try {
      mockPruneSyncedBackgroundCache
        .mockResolvedValueOnce({
          withinQuota: false,
          deletedFiles: 0,
          deletedBytes: 0,
          remainingFiles: 11,
          remainingBytes: 110,
        })
        .mockRejectedValueOnce(new Error('filesystem temporarily unavailable'))
        .mockResolvedValueOnce({
          withinQuota: true,
          deletedFiles: 1,
          deletedBytes: 10,
          remainingFiles: 10,
          remainingBytes: 100,
        });
      const run = ensureSyncedBackground(
        {
          snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
        } as never,
        {} as AppDatabase,
        'chat-1',
        { generation: 19, isCurrent: () => true },
      );
      const pending = await takePendingDownload();
      pending.resolve();
      await run;

      await jest.advanceTimersByTimeAsync(SYNCED_BACKGROUND_CACHE_REPAIR_DELAY_MS);
      expect(mockPruneSyncedBackgroundCache).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(SYNCED_BACKGROUND_CACHE_REPAIR_DELAY_MS);
      expect(mockPruneSyncedBackgroundCache).toHaveBeenCalledTimes(3);
      expect(mockPruneSyncedBackgroundCache).toHaveBeenLastCalledWith(null);
    } finally {
      jest.useRealTimers();
    }
  });

  it('queues delayed repair behind an in-flight promotion and DB commit', async () => {
    jest.useFakeTimers();
    try {
      mockPruneSyncedBackgroundCache
        .mockResolvedValueOnce({
          withinQuota: false,
          deletedFiles: 0,
          deletedBytes: 0,
          remainingFiles: 11,
          remainingBytes: 110,
        })
        .mockResolvedValueOnce({
          withinQuota: true,
          deletedFiles: 1,
          deletedBytes: 10,
          remainingFiles: 10,
          remainingBytes: 100,
        })
        .mockResolvedValueOnce({
          withinQuota: true,
          deletedFiles: 0,
          deletedBytes: 0,
          remainingFiles: 10,
          remainingBytes: 100,
        });

      const firstRun = ensureSyncedBackground(
        {
          snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
        } as never,
        {} as AppDatabase,
        'chat-1',
        { generation: 23, isCurrent: () => true },
      );
      const firstDownload = await takePendingDownload();
      firstDownload.resolve();
      await firstRun;

      const secondRun = ensureSyncedBackground(
        {
          snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
        } as never,
        {} as AppDatabase,
        'chat-1',
        { generation: 24, isCurrent: () => true },
      );
      const secondDownload = await takePendingDownload();

      await jest.advanceTimersByTimeAsync(SYNCED_BACKGROUND_CACHE_REPAIR_DELAY_MS);
      expect(mockPruneSyncedBackgroundCache).toHaveBeenCalledTimes(1);

      secondDownload.resolve();
      await secondRun;
      for (
        let attempt = 0;
        attempt < 20 && mockPruneSyncedBackgroundCache.mock.calls.length < 3;
        attempt += 1
      ) {
        await Promise.resolve();
      }

      expect(mockPruneSyncedBackgroundCache.mock.calls).toEqual([
        [firstDownload.finalUri],
        [secondDownload.finalUri],
        [null],
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('removes an app-owned persistent wallpaper after the server clears its channel', async () => {
    const previous = backgroundUri(14);
    mockFileBytes.set(previous, 10);
    getSyncedBackgroundState.mockResolvedValueOnce({ channel: '', uri: previous });

    await ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      { generation: 14, isCurrent: () => true },
    );

    expect(setSyncedBackgroundUriIfCurrent).toHaveBeenCalledWith(
      expect.anything(),
      'chat-1',
      null,
      previous,
      null,
    );
    expect(mockDeleteSyncedBackgroundCacheFile).toHaveBeenCalledWith(previous);
  });

  it('retains the referenced wallpaper when removal loses channel validation', async () => {
    const previous = backgroundUri(14);
    mockFileBytes.set(previous, 10);
    getSyncedBackgroundState.mockResolvedValueOnce({ channel: '', uri: previous });
    setSyncedBackgroundUriIfCurrent.mockResolvedValueOnce(false);

    await ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      { generation: 14, isCurrent: () => true },
    );

    expect(setSyncedBackgroundUriIfCurrent).toHaveBeenCalledWith(
      expect.anything(),
      'chat-1',
      null,
      previous,
      null,
    );
    expect(mockDeletedUris).not.toContain(previous);
    expect(mockDeleteSyncedBackgroundCacheFile).not.toHaveBeenCalledWith(previous);
    expect(mockFileBytes.has(previous)).toBe(true);
  });

  it('swallows native rejection of an encoded-traversal DB URI without Expo deletion', async () => {
    const unexpected =
      'file:///documents/synced-backgrounds/generation-1/media-%2F..%2F..%2Fdatabases%2Fgator.db#x.jpg';
    mockFileBytes.set(unexpected, 10);
    mockDeleteSyncedBackgroundCacheFile.mockRejectedValueOnce(new Error('not an owned file'));
    getSyncedBackgroundState.mockResolvedValueOnce({ channel: '', uri: unexpected });

    await ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      { generation: 15, isCurrent: () => true },
    );

    expect(setSyncedBackgroundUriIfCurrent).toHaveBeenCalledWith(
      expect.anything(),
      'chat-1',
      null,
      unexpected,
      null,
    );
    expect(mockDeletedUris).not.toContain(unexpected);
    expect(mockDeleteSyncedBackgroundCacheFile).toHaveBeenCalledWith(unexpected);
    expect(mockFileBytes.has(unexpected)).toBe(true);
  });

  it('does not reuse a matching-channel file from an older generation', async () => {
    getSyncedBackgroundState.mockResolvedValueOnce({
      channel: 'channel-1',
      uri: backgroundUri(21),
    });
    const context: EventDeliveryContext = { generation: 22, isCurrent: () => true };
    const run = ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      context,
    );

    const pending = await takePendingDownload();
    expect(pending.finalUri).toBe(backgroundUri(22));
    pending.resolve();
    await run;

    expect(setSyncedBackgroundUriIfCurrent).toHaveBeenCalledWith(
      expect.anything(),
      'chat-1',
      'channel-1',
      backgroundUri(21),
      pending.finalUri,
    );
  });

  it('does not reuse a lookalike URI outside the app-owned background directory', async () => {
    const owned = backgroundUri(22);
    const lookalike = owned.replace('/synced-backgrounds/', '/unowned/');
    mockFileBytes.set(lookalike, 10);
    mockDeleteSyncedBackgroundCacheFile.mockRejectedValueOnce(new Error('not an owned file'));
    getSyncedBackgroundState.mockResolvedValueOnce({ channel: 'channel-1', uri: lookalike });
    const run = ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      { generation: 22, isCurrent: () => true },
    );

    const pending = await takePendingDownload();
    expect(pending.finalUri).toBe(owned);
    pending.resolve();
    await run;

    expect(setSyncedBackgroundUriIfCurrent).toHaveBeenCalledWith(
      expect.anything(),
      'chat-1',
      'channel-1',
      lookalike,
      owned,
    );
    expect(mockDeletedUris).not.toContain(lookalike);
    expect(mockDeleteSyncedBackgroundCacheFile).toHaveBeenCalledWith(lookalike);
  });

  it('does not mistake a longer channel id for the exact current channel', async () => {
    getSyncedBackgroundState.mockResolvedValueOnce({
      channel: 'channel-1',
      uri: backgroundUri(22, 'channel-12'),
    });
    const context: EventDeliveryContext = { generation: 22, isCurrent: () => true };
    const run = ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      context,
    );

    const pending = await takePendingDownload();
    expect(pending.finalUri).toBe(backgroundUri(22));
    pending.resolve();
    await run;

    expect(setSyncedBackgroundUriIfCurrent).toHaveBeenCalledWith(
      expect.anything(),
      'chat-1',
      'channel-1',
      backgroundUri(22, 'channel-12'),
      pending.finalUri,
    );
  });

  it('cancels streamed wallpaper bytes at the 10 MiB cap and commits no URI', async () => {
    const context: EventDeliveryContext = { generation: 31, isCurrent: () => true };
    const run = ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      context,
    );
    const pending = await takePendingDownload();

    pending.resolve(SYNCED_BACKGROUND_MAX_BYTES + 1, SYNCED_BACKGROUND_MAX_BYTES + 1, -1);
    await run;

    expect(pending.cancel).toHaveBeenCalled();
    expect(mockDeletedUris).toContain(pending.destinationUri);
    expect(setSyncedBackgroundUriIfCurrent).not.toHaveBeenCalled();
  });

  it('rejects a false small Content-Length after final stat and removes the partial', async () => {
    const context: EventDeliveryContext = { generation: 32, isCurrent: () => true };
    const run = ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      context,
    );
    const pending = await takePendingDownload();

    pending.resolve(SYNCED_BACKGROUND_MAX_BYTES + 1, 1, 1);
    await run;

    expect(pending.cancel).not.toHaveBeenCalled();
    expect(mockDeletedUris).toContain(pending.destinationUri);
    expect(setSyncedBackgroundUriIfCurrent).not.toHaveBeenCalled();
  });

  it('rejects an empty wallpaper because zero also represents an unreadable Expo file', async () => {
    const context: EventDeliveryContext = { generation: 33, isCurrent: () => true };
    const run = ensureSyncedBackground(
      {
        snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
      } as never,
      {} as AppDatabase,
      'chat-1',
      context,
    );
    const pending = await takePendingDownload();

    pending.resolve(0, 0, 0);
    await run;

    expect(mockDeletedUris).toContain(pending.destinationUri);
    expect(setSyncedBackgroundUriIfCurrent).not.toHaveBeenCalled();
  });

  it('cancels and cleans a partial wallpaper at the 60-second deadline', async () => {
    const context: EventDeliveryContext = { generation: 34, isCurrent: () => true };
    jest.useFakeTimers();
    try {
      const run = ensureSyncedBackground(
        {
          snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
        } as never,
        {} as AppDatabase,
        'chat-1',
        context,
      );
      const pending = await takePendingDownload();
      mockFileBytes.set(pending.destinationUri, 10);

      await jest.advanceTimersByTimeAsync(SYNCED_BACKGROUND_TIMEOUT_MS);
      await run;

      expect(pending.cancel).toHaveBeenCalled();
      expect(mockDeletedUris).toContain(pending.destinationUri);
      expect(setSyncedBackgroundUriIfCurrent).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('promptly cancels a no-progress wallpaper when its account generation is revoked', async () => {
    let current = true;
    const context: EventDeliveryContext = { generation: 35, isCurrent: () => current };
    jest.useFakeTimers();
    try {
      const run = ensureSyncedBackground(
        {
          snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
        } as never,
        {} as AppDatabase,
        'chat-1',
        context,
      );
      const pending = await takePendingDownload();
      mockFileBytes.set(pending.destinationUri, 10);

      current = false;
      await jest.advanceTimersByTimeAsync(100);
      await run;

      expect(pending.cancel).toHaveBeenCalled();
      expect(mockDeletedUris).toContain(pending.destinationUri);
      expect(setSyncedBackgroundUriIfCurrent).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
