/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
const mockRepairAttachmentCache = jest.fn();
jest.mock('@db/database', () => ({ getDatabase: () => ({}) }));
jest.mock('@/services/clients', () => ({ http: {} }));
jest.mock('@/services/download/expoFetcher', () => ({ expoFetcher: () => ({}) }));
jest.mock('@/services/download/attachmentCacheRecovery', () => ({
  ...jest.requireActual('@/services/download/attachmentCacheRecovery'),
  repairAttachmentCache: (...args: unknown[]) => mockRepairAttachmentCache(...args),
}));

import {
  getDownloadRepairProgress,
  repairStuckDownloads,
  subscribeDownloadRepair,
} from '@/services/download';

// Review item 888 follow-up: leaving and reopening Storage must show the repair already running
// instead of offering a second one.
describe('repairStuckDownloads', () => {
  beforeEach(() => {
    mockRepairAttachmentCache.mockReset();
  });

  it('runs one repair at a time and shares its progress until it settles', async () => {
    let finish: (result: unknown) => void = () => undefined;
    let reportProgress: (progress: { checkedFiles: number; removedFiles: number }) => void = () =>
      undefined;
    mockRepairAttachmentCache.mockImplementation(
      (_db: unknown, _lease: unknown, dependencies: { onProgress: typeof reportProgress }) => {
        reportProgress = dependencies.onProgress;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    const seen: (number | null)[] = [];
    const unsubscribe = subscribeDownloadRepair(() => seen.push(getDownloadRepairProgress()));

    const first = repairStuckDownloads();
    expect(repairStuckDownloads()).toBe(first);
    expect(getDownloadRepairProgress()).toBe(0);
    reportProgress({ checkedFiles: 200, removedFiles: 0 });
    expect(getDownloadRepairProgress()).toBe(200);

    finish({ status: 'not-needed' });
    await expect(first).resolves.toEqual({ status: 'not-needed' });
    expect(getDownloadRepairProgress()).toBeNull();
    expect(seen).toEqual([0, 200, null]);
    expect(mockRepairAttachmentCache).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('clears its progress when a repair fails, so it can be tried again', async () => {
    mockRepairAttachmentCache.mockRejectedValueOnce(new Error('Attachment cache scan corrupt'));

    await expect(repairStuckDownloads()).rejects.toThrow('corrupt');
    expect(getDownloadRepairProgress()).toBeNull();

    mockRepairAttachmentCache.mockResolvedValueOnce({ status: 'not-needed' });
    await expect(repairStuckDownloads()).resolves.toEqual({ status: 'not-needed' });
    expect(mockRepairAttachmentCache).toHaveBeenCalledTimes(2);
  });
});
