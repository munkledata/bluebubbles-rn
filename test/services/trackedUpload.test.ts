import {
  nullUploadSink,
  runTrackedUpload,
  type UploadProgressSink,
  type UploadStartInfo,
} from '@/services/send/trackedUpload';

interface Recorded {
  started: { key: string; info: UploadStartInfo }[];
  progressed: { key: string; sent: number; total: number }[];
  settled: string[];
}

function recordingSink(): { sink: UploadProgressSink; log: Recorded } {
  const log: Recorded = { started: [], progressed: [], settled: [] };
  return {
    log,
    sink: {
      start: (key, info) => log.started.push({ key, info }),
      progress: (key, sent, total) => log.progressed.push({ key, sent, total }),
      settle: (key) => log.settled.push(key),
    },
  };
}

const INFO: UploadStartInfo = { chatGuid: 'c1', name: 'photo.jpg', total: 1000 };

describe('runTrackedUpload', () => {
  it('opens an entry, forwards byte updates under the same key, and settles on success', async () => {
    const { sink, log } = recordingSink();

    const out = await runTrackedUpload(sink, 'att-1', INFO, async (onProgress) => {
      onProgress(250, 1000);
      onProgress(1000, 1000);
      return 'ack';
    });

    expect(out).toBe('ack');
    expect(log.started).toEqual([{ key: 'att-1', info: INFO }]);
    expect(log.progressed).toEqual([
      { key: 'att-1', sent: 250, total: 1000 },
      { key: 'att-1', sent: 1000, total: 1000 },
    ]);
    expect(log.settled).toEqual(['att-1']);
  });

  it('settles the entry when the upload THROWS', async () => {
    // The whole reason this wrapper exists. The entry draws the bubble spinner and keeps the
    // composer's upload bar on screen, so an unsettled one is a permanent phantom "sending" for a
    // message that failed minutes ago — with nothing left running to ever clear it.
    const { sink, log } = recordingSink();

    await expect(
      runTrackedUpload(sink, 'att-2', INFO, async (onProgress) => {
        onProgress(100, 1000);
        throw new Error('network died');
      }),
    ).rejects.toThrow('network died');

    expect(log.started).toHaveLength(1);
    expect(log.settled).toEqual(['att-2']);
  });

  it('settles even when the upload resolves with nothing (the cancelled shape)', async () => {
    const { sink, log } = recordingSink();
    const out = await runTrackedUpload(sink, 'att-3', INFO, async () => null);
    expect(out).toBeNull();
    expect(log.settled).toEqual(['att-3']);
  });

  it('settles exactly once', async () => {
    const { sink, log } = recordingSink();
    await runTrackedUpload(sink, 'att-4', INFO, async () => 'ok');
    expect(log.settled).toEqual(['att-4']);
  });

  it('nullUploadSink is inert for callers with no UI to update', async () => {
    await expect(
      runTrackedUpload(nullUploadSink, 'att-5', INFO, async (onProgress) => {
        onProgress(1, 2);
        return 42;
      }),
    ).resolves.toBe(42);
  });
});
