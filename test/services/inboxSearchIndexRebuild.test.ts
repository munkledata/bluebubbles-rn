import { rebuildInboxSearchIndexBatch } from '@db/repositories/inboxSearchIndex';
import { runInboxSearchIndexRebuildOnce } from '@/services/search/inboxSearchIndexRebuild';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

jest.mock('@db/database', () => ({ getDatabase: jest.fn(() => ({})) }));
jest.mock('@db/repositories/inboxSearchIndex', () => ({ rebuildInboxSearchIndexBatch: jest.fn() }));

const mockBatch = rebuildInboxSearchIndexBatch as jest.MockedFunction<
  typeof rebuildInboxSearchIndexBatch
>;

beforeEach(() => {
  resumeRealtimeDeliveries();
  mockBatch.mockReset();
});

afterEach(() => {
  resumeRealtimeDeliveries();
});

describe('inbox search index rebuild owner', () => {
  it('walks bounded batches and stops after the queue is empty', async () => {
    mockBatch
      .mockResolvedValueOnce({ visited: 1, lastChatId: 7, settled: 1, deferred: 0 })
      .mockResolvedValueOnce({ visited: 0, lastChatId: 7, settled: 0, deferred: 0 })
      .mockResolvedValueOnce({ visited: 0, lastChatId: 0, settled: 0, deferred: 0 });

    await runInboxSearchIndexRebuildOnce(captureRealtimeDeliveryLease());
    expect(mockBatch.mock.calls.map((call) => call[1])).toEqual([0, 7, 0]);
  });

  it('does not start another batch after account retirement', async () => {
    let releaseBatch!: (result: Awaited<ReturnType<typeof rebuildInboxSearchIndexBatch>>) => void;
    mockBatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseBatch = resolve;
        }),
    );

    const pass = runInboxSearchIndexRebuildOnce(captureRealtimeDeliveryLease());
    for (let turn = 0; turn < 10 && mockBatch.mock.calls.length === 0; turn += 1) {
      await Promise.resolve();
    }
    expect(mockBatch).toHaveBeenCalledTimes(1);
    const retired = pauseRealtimeDeliveries();
    releaseBatch({ visited: 1, lastChatId: 7, settled: 1, deferred: 0 });
    await Promise.all([pass, retired]);
    expect(mockBatch).toHaveBeenCalledTimes(1);
  });
});
