/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
/**
 * Behavior of the synced-background cache maintenance and its bounded delayed repair (review
 * M206). These replace source-text regexes that pinned how the service was written.
 */
const mockPrune = jest.fn();

jest.mock('@core/api', () => ({ chatsApi: {} }));
jest.mock('@native/boundedDownload', () => ({
  deleteNativeSyncedBackgroundCacheFile: jest.fn(),
  prepareNativeSyncedBackgroundCacheForDownload: jest.fn(),
  pruneNativeSyncedBackgroundCache: (keepUri: string | null) => mockPrune(keepUri),
  validateNativeSyncedBackgroundCacheFile: jest.fn(),
}));
jest.mock('@/services/download/boundedNativeDownload', () => ({
  BoundedDownloadError: class BoundedDownloadError extends Error {},
  deleteOwnedFile: jest.fn(),
  downloadBoundedNativeFile: jest.fn(),
}));
jest.mock('@/services/backgrounds/luminance', () => ({ computeBackgroundIsLight: jest.fn() }));
jest.mock('@/services/clients', () => ({ http: {} }));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: jest.fn() }));
jest.mock('expo-file-system', () => ({ Paths: {}, Directory: class {}, File: class {} }));

type SyncedBackgroundModule = typeof import('@/services/backgrounds/syncedBackground');

function prune(withinQuota: boolean) {
  return { withinQuota, deletedFiles: 0, deletedBytes: 0, remainingFiles: 0, remainingBytes: 0 };
}

/** A fresh copy of the service, so its process-wide timer and single-flight state start empty. */
function loadService(): SyncedBackgroundModule {
  let service!: SyncedBackgroundModule;
  jest.isolateModules(() => {
    service = require('@/services/backgrounds/syncedBackground') as SyncedBackgroundModule;
  });
  return service;
}

beforeEach(() => {
  mockPrune.mockReset();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('synced-background cache maintenance', () => {
  it('serializes background work through a single slot', () => {
    expect(loadService().SYNCED_BACKGROUND_MAX_CONCURRENT).toBe(1);
  });

  it('runs startup maintenance once per process and keeps nothing', async () => {
    mockPrune.mockResolvedValue(prune(true));
    const service = loadService();

    const first = service.startSyncedBackgroundCacheMaintenance();
    expect(service.startSyncedBackgroundCacheMaintenance()).toBe(first);
    await first;

    expect(mockPrune.mock.calls).toEqual([[null]]);
    await jest.advanceTimersByTimeAsync(10 * service.SYNCED_BACKGROUND_CACHE_REPAIR_DELAY_MS);
    expect(mockPrune).toHaveBeenCalledTimes(1);
  });

  it('retries an overage exactly twice after the repair delay, then stops', async () => {
    mockPrune.mockResolvedValue(prune(false));
    const service = loadService();
    const delay = service.SYNCED_BACKGROUND_CACHE_REPAIR_DELAY_MS;

    await service.startSyncedBackgroundCacheMaintenance();
    expect(mockPrune).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(delay - 1);
    expect(mockPrune).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockPrune).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(delay);
    expect(mockPrune).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(10 * delay);
    expect(mockPrune).toHaveBeenCalledTimes(3);
    // A repair never exempts a file: every sweep keeps nothing.
    expect(mockPrune.mock.calls).toEqual([[null], [null], [null]]);
  });

  it('stops repairing as soon as a sweep is within quota', async () => {
    mockPrune.mockResolvedValueOnce(prune(false)).mockResolvedValue(prune(true));
    const service = loadService();

    await service.startSyncedBackgroundCacheMaintenance();
    await jest.advanceTimersByTimeAsync(10 * service.SYNCED_BACKGROUND_CACHE_REPAIR_DELAY_MS);

    expect(mockPrune).toHaveBeenCalledTimes(2);
  });

  it('schedules the same bounded repair when a sweep fails', async () => {
    mockPrune
      .mockRejectedValueOnce(new Error('native sweep failed'))
      .mockRejectedValueOnce(new Error('still failing'))
      .mockResolvedValue(prune(true));
    const service = loadService();

    await expect(service.startSyncedBackgroundCacheMaintenance()).resolves.toBeUndefined();
    await jest.advanceTimersByTimeAsync(10 * service.SYNCED_BACKGROUND_CACHE_REPAIR_DELAY_MS);

    // The startup failure and a failed first repair are each followed by one more attempt.
    expect(mockPrune).toHaveBeenCalledTimes(3);
  });
});
