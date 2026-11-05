const mockRetireChatEntries = jest.fn();

jest.mock('@/services/download/attachmentCacheCoordinator', () => ({
  attachmentCacheCoordinator: {
    retireChatEntries: (...args: unknown[]) => mockRetireChatEntries(...args),
  },
}));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: async () => ({ fake: 'db' }) }));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  runTrackedRealtimeWork: async (
    lease: { isCurrent: () => boolean },
    work: (lease: { isCurrent: () => boolean }) => Promise<void>,
  ) => {
    if (!lease.isCurrent()) return 'paused';
    await work(lease);
    return lease.isCurrent() ? 'delivered' : 'paused';
  },
}));

// eslint-disable-next-line import/first
import { removeChatDownloadedFiles } from '@/services/download/removeChatDownloads';

const pass = (attempted: number, confirmed: number, failed: number, skipped: number) => ({
  status: 'complete',
  attempted,
  confirmed,
  failed,
  skipped,
});

beforeEach(() => mockRetireChatEntries.mockReset());

it('repeats passes until one finds nothing, adding up what each removed', async () => {
  const lease = { generation: 4, isCurrent: () => true };
  mockRetireChatEntries
    .mockResolvedValueOnce(pass(100, 99, 1, 2))
    .mockResolvedValueOnce(pass(30, 30, 0, 2))
    .mockResolvedValueOnce(pass(0, 0, 0, 2));

  await expect(removeChatDownloadedFiles('chat-a', lease)).resolves.toEqual({
    status: 'complete',
    removed: 129,
    failed: 1,
    kept: 2,
  });
  expect(mockRetireChatEntries).toHaveBeenCalledTimes(3);
  expect(mockRetireChatEntries.mock.calls[0]?.[1]).toMatchObject({ chatGuid: 'chat-a' });
});

it('stops and reports stale when the account changes part-way', async () => {
  let current = true;
  const lease = { generation: 4, isCurrent: () => current };
  mockRetireChatEntries.mockImplementationOnce(async () => {
    current = false;
    return pass(100, 100, 0, 0);
  });

  await expect(removeChatDownloadedFiles('chat-a', lease)).resolves.toMatchObject({
    status: 'stale',
    removed: 100,
  });
  expect(mockRetireChatEntries).toHaveBeenCalledTimes(1);
});

it('does nothing for an account that is already gone', async () => {
  const lease = { generation: 4, isCurrent: () => false };
  await expect(removeChatDownloadedFiles('chat-a', lease)).resolves.toMatchObject({
    status: 'stale',
    removed: 0,
  });
  expect(mockRetireChatEntries).not.toHaveBeenCalled();
});
