/**
 * loadVideoPoster (src/services/download/videoPosters.ts): fetches a video attachment's still JPEG
 * from the server's poster route through the bounded native downloader, saves it under the
 * account generation's folder, and remembers what the server said. The native download and the
 * filesystem are mocked in-file; the real account-delivery coordinator supplies the leases.
 */
jest.mock('expo-file-system', () => {
  const disk = new Map<string, number>();
  const deletedDirs: string[] = [];
  class MockDirectory {
    readonly uri: string;
    constructor(base: { uri: string } | string, ...names: string[]) {
      const root = typeof base === 'string' ? base : base.uri;
      this.uri = [root, ...names].join('/');
    }
    get exists(): boolean {
      return [...disk.keys()].some((uri) => uri.startsWith(`${this.uri}/`));
    }
    create(): void {}
    list(): { uri: string }[] {
      return [...disk.keys()]
        .filter((uri) => uri.startsWith(`${this.uri}/`))
        .map((uri) => ({ uri }));
    }
    delete(): void {
      deletedDirs.push(this.uri);
      for (const uri of [...disk.keys()]) if (uri.startsWith(`${this.uri}/`)) disk.delete(uri);
    }
  }
  class MockFile {
    readonly uri: string;
    constructor(dir: { uri: string } | string, name?: string) {
      const base = typeof dir === 'string' ? dir : dir.uri;
      this.uri = name == null ? base : `${base}/${name}`;
    }
    get exists(): boolean {
      return disk.has(this.uri);
    }
    get size(): number {
      return disk.get(this.uri) ?? 0;
    }
  }
  return {
    Paths: { document: 'file:///doc' },
    Directory: MockDirectory,
    File: MockFile,
    mockDisk: disk,
    mockDeletedDirs: deletedDirs,
  };
});

jest.mock('../../src/services/download/boundedNativeDownload', () => {
  class BoundedDownloadError extends Error {
    constructor(readonly reason: string) {
      super(`bounded download rejected: ${reason}`);
    }
  }
  return {
    BoundedDownloadError,
    downloadBoundedNativeFile: jest.fn(),
    deleteOwnedFile: jest.fn(),
  };
});

// The real endpoint helpers, without loading the HTTP client (its `ky` dependency is ESM-only).
jest.mock('@core/api', () => ({
  attachmentsApi: jest.requireActual('../../src/core/api/endpoints/attachments'),
}));

const mockTransportCurrent = { value: true };
jest.mock('../../src/services/clients', () => ({
  http: {
    pinTransport: () => ({
      isTransportCurrent: () => mockTransportCurrent.value,
      snapshotTransport: () => ({
        headers: { Authorization: 'Bearer x' },
        buildUrl: (path: string) => `https://server/api/v1${path}`,
      }),
    }),
  },
}));

// eslint-disable-next-line import/first
import * as fileSystem from 'expo-file-system';
// eslint-disable-next-line import/first
import {
  BoundedDownloadError,
  deleteOwnedFile,
  downloadBoundedNativeFile,
} from '../../src/services/download/boundedNativeDownload';
// eslint-disable-next-line import/first
import {
  loadVideoPoster,
  resetVideoPostersForTests,
  VIDEO_POSTER_FIRST_RETRY_MS,
  VIDEO_POSTER_MAX_BYTES,
  VIDEO_POSTER_MAX_CONCURRENT,
  VIDEO_POSTER_MAX_FILES,
  VIDEO_POSTER_MAX_PIXELS,
  VIDEO_POSTER_MAX_RETRY_MS,
  VIDEO_POSTER_MAX_WAITING,
  VIDEO_POSTER_TIMEOUT_MS,
} from '@/services/download/videoPosters';
// eslint-disable-next-line import/first
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
// eslint-disable-next-line import/first
import { attachmentPosterUrl } from '@core/api/endpoints/attachments';

const disk = (fileSystem as unknown as { mockDisk: Map<string, number> }).mockDisk;
const deletedDirs = (fileSystem as unknown as { mockDeletedDirs: string[] }).mockDeletedDirs;
const mockDownload = downloadBoundedNativeFile as jest.Mock;
const mockDelete = deleteOwnedFile as jest.Mock;

interface DownloadCall {
  url: string;
  destination: { uri: string };
  headers: Record<string, string>;
  maxBytes: number;
  timeoutMs: number;
  maxImagePixels: number;
  shouldContinue: () => boolean;
}

function lastCall(): DownloadCall {
  const call = mockDownload.mock.calls.at(-1) as [DownloadCall] | undefined;
  if (!call) throw new Error('no download call');
  return call[0];
}

/** Each download writes its destination and succeeds. */
function succeed(): void {
  mockDownload.mockImplementation(async (options: DownloadCall) => {
    disk.set(options.destination.uri, 2048);
    return { file: options.destination, bytes: 2048 };
  });
}

/** Each download stays open until the test finishes it (by call order). */
function hold(): ((outcome?: Error) => void)[] {
  const finishers: ((outcome?: Error) => void)[] = [];
  mockDownload.mockImplementation(
    (options: DownloadCall) =>
      new Promise((resolve, reject) => {
        finishers.push((outcome?: Error) => {
          if (outcome) {
            reject(outcome);
            return;
          }
          disk.set(options.destination.uri, 2048);
          resolve({ file: options.destination, bytes: 2048 });
        });
      }),
  );
  return finishers;
}

function postersOnDisk(): number {
  return [...disk.keys()].filter((uri) => uri.startsWith(`${generationFolder()}/`)).length;
}

function generationFolder(): string {
  return `file:///doc/video-posters/generation-${captureRealtimeDeliveryLease().generation}`;
}

/** Let queued promise continuations run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  disk.clear();
  deletedDirs.length = 0;
  mockDownload.mockReset();
  mockDelete.mockReset();
  mockDelete.mockImplementation((file: { uri: string }) => disk.delete(file.uri));
  mockTransportCurrent.value = true;
  resetVideoPostersForTests();
  resumeRealtimeDeliveries();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('attachmentPosterUrl', () => {
  const builder = { buildUrl: (path: string) => `https://server/api/v1${path}` };

  it('asks the iMessage poster route for one width, with the guid encoded', () => {
    expect(attachmentPosterUrl(builder, 'at_0/AB+C', 512)).toBe(
      'https://server/api/v1/attachment/at_0%2FAB%2BC/poster?width=512',
    );
  });

  it.each([0, 63, 1025, 512.5, Number.NaN])(
    'refuses width %p outside the server range',
    (width) => {
      expect(() => attachmentPosterUrl(builder, 'guid', width)).toThrow(RangeError);
    },
  );
});

describe('loadVideoPoster', () => {
  it('downloads the poster with the bounded limits into the account folder', async () => {
    succeed();
    const uri = await loadVideoPoster('video-1');

    expect(mockDownload).toHaveBeenCalledTimes(1);
    const call = lastCall();
    expect(call.url).toBe('https://server/api/v1/attachment/video-1/poster?width=512');
    expect(call.headers).toEqual({ Authorization: 'Bearer x' });
    expect(call.maxBytes).toBe(VIDEO_POSTER_MAX_BYTES);
    expect(call.timeoutMs).toBe(VIDEO_POSTER_TIMEOUT_MS);
    expect(call.maxImagePixels).toBe(VIDEO_POSTER_MAX_PIXELS);
    expect(call.destination.uri.startsWith(`${generationFolder()}/media-`)).toBe(true);
    expect(call.destination.uri.endsWith('.jpg')).toBe(true);
    expect(uri).toBe(call.destination.uri);
  });

  it('reuses a saved poster without asking the server again', async () => {
    succeed();
    const first = await loadVideoPoster('video-1');
    const second = await loadVideoPoster('video-1');

    expect(second).toBe(first);
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['oversized', VIDEO_POSTER_MAX_BYTES + 1],
    ['empty', 0],
  ])('never treats an %s file as a saved poster', async (_kind, bytes) => {
    succeed();
    const first = await loadVideoPoster('video-1');
    disk.set(first!, bytes);

    await expect(loadVideoPoster('video-1')).resolves.toBe(first);
    expect(mockDownload).toHaveBeenCalledTimes(2);
    expect(disk.get(first!)).toBe(2048);
  });

  it('shares one request between tiles asking for the same video at once', async () => {
    succeed();
    const [a, b] = await Promise.all([loadVideoPoster('video-1'), loadVideoPoster('video-1')]);

    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it('never asks again this session after the server says there is no poster (404)', async () => {
    mockDownload.mockRejectedValue(new BoundedDownloadError('missing'));

    await expect(loadVideoPoster('video-1')).resolves.toBeNull();
    await expect(loadVideoPoster('video-1')).resolves.toBeNull();
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it('treats an oversized or undecodable answer as no poster', async () => {
    mockDownload.mockRejectedValue(new BoundedDownloadError('size'));

    await expect(loadVideoPoster('video-1')).resolves.toBeNull();
    await expect(loadVideoPoster('video-1')).resolves.toBeNull();
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it.each(['network', 'timeout'] as const)(
    'waits before asking again after a %s failure (busy server included)',
    async (reason) => {
      const start = 1_700_000_000_000;
      jest.useFakeTimers({ now: start });
      mockDownload.mockRejectedValueOnce(new BoundedDownloadError(reason));

      await expect(loadVideoPoster('video-1')).resolves.toBeNull();
      jest.setSystemTime(start + VIDEO_POSTER_FIRST_RETRY_MS - 1);
      await expect(loadVideoPoster('video-1')).resolves.toBeNull();
      expect(mockDownload).toHaveBeenCalledTimes(1);

      jest.setSystemTime(start + VIDEO_POSTER_FIRST_RETRY_MS + 1);
      succeed();
      await expect(loadVideoPoster('video-1')).resolves.not.toBeNull();
      expect(mockDownload).toHaveBeenCalledTimes(2);
    },
  );

  it('doubles the wait for each further failure, up to the maximum', async () => {
    let now = 1_700_000_000_000;
    jest.useFakeTimers({ now });
    mockDownload.mockRejectedValue(new BoundedDownloadError('network'));
    let wait = VIDEO_POSTER_FIRST_RETRY_MS;
    const waits: number[] = [];
    for (let failure = 1; failure <= 7; failure += 1) {
      await loadVideoPoster('video-1');
      expect(mockDownload).toHaveBeenCalledTimes(failure);
      // One moment before the wait ends: still no new request.
      jest.setSystemTime(now + wait - 1);
      await loadVideoPoster('video-1');
      expect(mockDownload).toHaveBeenCalledTimes(failure);
      waits.push(wait);
      now += wait;
      jest.setSystemTime(now);
      wait = Math.min(wait * 2, VIDEO_POSTER_MAX_RETRY_MS);
    }
    expect(waits.slice(0, 3)).toEqual([
      VIDEO_POSTER_FIRST_RETRY_MS,
      2 * VIDEO_POSTER_FIRST_RETRY_MS,
      4 * VIDEO_POSTER_FIRST_RETRY_MS,
    ]);
    expect(waits.at(-1)).toBe(VIDEO_POSTER_MAX_RETRY_MS);
  });

  it.each([
    ['a phone-side unavailable download', new BoundedDownloadError('unavailable')],
    ['a plain native error', new Error('native prepare failed')],
  ])('does not remember %s, so the next look asks again', async (_kind, failure) => {
    mockDownload.mockRejectedValueOnce(failure);
    await expect(loadVideoPoster('video-1')).resolves.toBeNull();

    succeed();
    await expect(loadVideoPoster('video-1')).resolves.not.toBeNull();
    expect(mockDownload).toHaveBeenCalledTimes(2);
  });

  it('runs at most two downloads at once and starts the next when one finishes', async () => {
    const finishers = hold();

    const loads = ['v1', 'v2', 'v3'].map((guid) => loadVideoPoster(guid));
    await flush();
    expect(mockDownload).toHaveBeenCalledTimes(2);

    finishers[0]!();
    await flush();
    expect(mockDownload).toHaveBeenCalledTimes(3);

    finishers[1]!();
    finishers[2]!();
    const uris = await Promise.all(loads);
    expect(uris.every((uri) => typeof uri === 'string')).toBe(true);
  });

  it('drops a poster that arrives after Disconnect and forgets the old account', async () => {
    let finish!: () => void;
    mockDownload.mockImplementationOnce(
      (options: DownloadCall) =>
        new Promise((resolve) => {
          finish = () => {
            disk.set(options.destination.uri, 2048);
            resolve({ file: options.destination, bytes: 2048 });
          };
        }),
    );
    const pending = loadVideoPoster('video-1');
    await flush();
    const oldDestination = lastCall().destination.uri;
    expect(lastCall().shouldContinue()).toBe(true);

    await pauseRealtimeDeliveries();
    expect(lastCall().shouldContinue()).toBe(false);
    finish();

    await expect(pending).resolves.toBeNull();
    expect(disk.has(oldDestination)).toBe(false);

    // The next account starts clean, in its own generation folder.
    resumeRealtimeDeliveries();
    succeed();
    const next = await loadVideoPoster('video-1');
    expect(next).not.toBeNull();
    expect(next).not.toBe(oldDestination);
    expect(next!.startsWith(`${generationFolder()}/`)).toBe(true);
  });

  it('does not start a request while the account is closed', async () => {
    await pauseRealtimeDeliveries();

    await expect(loadVideoPoster('video-1')).resolves.toBeNull();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('stops when the server connection changed before the download could start', async () => {
    mockTransportCurrent.value = false;

    await expect(loadVideoPoster('video-1')).resolves.toBeNull();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('clears the account folder once it holds the maximum number of posters', async () => {
    succeed();
    const folder = generationFolder();
    for (let i = 0; i < VIDEO_POSTER_MAX_FILES; i += 1)
      disk.set(`${folder}/media-old-${i}.jpg`, 10);

    const uri = await loadVideoPoster('video-new');

    expect(deletedDirs).toEqual([folder]);
    expect(uri).not.toBeNull();
    expect([...disk.keys()]).toEqual([uri]);
  });

  it('keeps an empty guid out of the filesystem and the network', async () => {
    await expect(loadVideoPoster('')).resolves.toBeNull();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it("does not carry one account's no-poster answer over to the next account", async () => {
    mockDownload.mockRejectedValueOnce(new BoundedDownloadError('missing'));
    await expect(loadVideoPoster('video-1')).resolves.toBeNull();
    await expect(loadVideoPoster('video-1')).resolves.toBeNull();
    expect(mockDownload).toHaveBeenCalledTimes(1);

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    succeed();

    await expect(loadVideoPoster('video-1')).resolves.not.toBeNull();
    expect(mockDownload).toHaveBeenCalledTimes(2);
  });

  it('lets a request still waiting at Disconnect leave without downloading', async () => {
    const finishers = hold();
    const loads = ['v1', 'v2', 'v3'].map((guid) => loadVideoPoster(guid));
    await flush();
    expect(mockDownload).toHaveBeenCalledTimes(2);

    await pauseRealtimeDeliveries();
    finishers[0]!();
    finishers[1]!();

    await expect(Promise.all(loads)).resolves.toEqual([null, null, null]);
    expect(mockDownload).toHaveBeenCalledTimes(2);
    expect(postersOnDisk()).toBe(0);
  });

  it('frees the slot of a failed download for the next request', async () => {
    const finishers = hold();
    const loads = ['v1', 'v2', 'v3'].map((guid) => loadVideoPoster(guid));
    await flush();

    finishers[0]!(new BoundedDownloadError('missing'));
    await flush();
    expect(mockDownload).toHaveBeenCalledTimes(3);

    finishers[1]!();
    finishers[2]!();
    const [first, second, third] = await Promise.all(loads);
    expect(first).toBeNull();
    expect(second).not.toBeNull();
    expect(third).not.toBeNull();
  });

  it('drops a request when the line is full, without queueing it', async () => {
    const finishers = hold();
    const capacity = VIDEO_POSTER_MAX_CONCURRENT + VIDEO_POSTER_MAX_WAITING;
    const loads = Array.from({ length: capacity }, (_, i) => loadVideoPoster(`v${i}`));
    await flush();

    await expect(loadVideoPoster('one-too-many')).resolves.toBeNull();

    for (let i = 0; i < capacity; i += 1) {
      finishers[i]!();
      await flush();
    }
    await Promise.all(loads);
    expect(mockDownload).toHaveBeenCalledTimes(capacity);
    expect(
      mockDownload.mock.calls.some(([call]) => (call as DownloadCall).url.includes('one-too-many')),
    ).toBe(false);
  });

  it("frees a closed screen's places in line at once, so the next screen is not dropped", async () => {
    const finishers = hold();
    const busy = ['v1', 'v2'].map((guid) => loadVideoPoster(guid));
    const closed = new AbortController();
    const abandoned = Array.from({ length: VIDEO_POSTER_MAX_WAITING }, (_, i) =>
      loadVideoPoster(`old-screen-${i}`, closed.signal),
    );
    await flush();
    await expect(loadVideoPoster('dropped-while-full')).resolves.toBeNull();

    closed.abort();
    await expect(Promise.all(abandoned)).resolves.toEqual(abandoned.map(() => null));
    const next = loadVideoPoster('next-screen');

    finishers[0]!();
    finishers[1]!();
    await flush();
    expect(lastCall().url).toContain('/attachment/next-screen/poster');
    finishers[2]!();
    await Promise.all([...busy, next]);
    await expect(next).resolves.not.toBeNull();
    expect(mockDownload).toHaveBeenCalledTimes(3);
  });

  it('gives up the place of a waiting request once its screen closes', async () => {
    const finishers = hold();
    const busy = ['v1', 'v2'].map((guid) => loadVideoPoster(guid));
    const closed = new AbortController();
    const leftBehind = loadVideoPoster('closed-screen', closed.signal);
    const next = loadVideoPoster('next-screen');
    await flush();
    expect(mockDownload).toHaveBeenCalledTimes(2);

    closed.abort();
    finishers[0]!();
    await flush();

    // The freed slot goes straight to the next screen's request, not the abandoned one.
    expect(mockDownload).toHaveBeenCalledTimes(3);
    expect(lastCall().url).toContain('/attachment/next-screen/poster');
    await expect(leftBehind).resolves.toBeNull();

    finishers[1]!();
    finishers[2]!();
    await Promise.all([...busy, next]);
    expect(
      mockDownload.mock.calls.some(([call]) =>
        (call as DownloadCall).url.includes('closed-screen'),
      ),
    ).toBe(false);
  });

  it('gives a tile that remounts at once a fresh request, not the withdrawn one', async () => {
    const finishers = hold();
    const busy = ['v1', 'v2'].map((guid) => loadVideoPoster(guid));
    const firstMount = new AbortController();
    const old = loadVideoPoster('remounted', firstMount.signal);
    // Unmount and mount again in the same tick (as StrictMode or Fast Refresh do).
    firstMount.abort();
    const again = loadVideoPoster('remounted', new AbortController().signal);
    await flush();

    finishers[0]!();
    await flush();
    expect(lastCall().url).toContain('/attachment/remounted/poster');
    finishers[1]!();
    finishers[2]!();
    await Promise.all(busy);
    await expect(again).resolves.not.toBeNull();
    await expect(old).resolves.toBeNull();
    expect(mockDownload).toHaveBeenCalledTimes(3);
  });

  it('replaces a saved poster whose image failed to load', async () => {
    succeed();
    const first = await loadVideoPoster('video-1');
    expect(mockDownload).toHaveBeenCalledTimes(1);

    // Without `replace` a usable file is a cache hit; with it, the file is fetched again.
    await expect(loadVideoPoster('video-1')).resolves.toBe(first);
    expect(mockDownload).toHaveBeenCalledTimes(1);
    await expect(loadVideoPoster('video-1', undefined, true)).resolves.toBe(first);
    expect(mockDownload).toHaveBeenCalledTimes(2);
    expect(mockDelete).toHaveBeenCalledWith(expect.objectContaining({ uri: first }));
  });

  it('never deletes a poster file while its download is already under way', async () => {
    const finishers = hold();
    const pending = loadVideoPoster('video-1');
    await flush();
    expect(mockDownload).toHaveBeenCalledTimes(1);
    mockDelete.mockClear();

    const replacing = loadVideoPoster('video-1', undefined, true);
    expect(mockDelete).not.toHaveBeenCalled();
    finishers[0]!();
    const [a, b] = await Promise.all([pending, replacing]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it('keeps a waiting request while another tile still wants it', async () => {
    const finishers = hold();
    const busy = ['v1', 'v2'].map((guid) => loadVideoPoster(guid));
    const closed = new AbortController();
    const fromClosedScreen = loadVideoPoster('shared', closed.signal);
    const fromOpenScreen = loadVideoPoster('shared', new AbortController().signal);
    await flush();

    closed.abort();
    finishers[0]!();
    await flush();
    expect(lastCall().url).toContain('/attachment/shared/poster');

    finishers[1]!();
    finishers[2]!();
    await Promise.all(busy);
    const uri = await fromOpenScreen;
    expect(uri).not.toBeNull();
    await expect(fromClosedScreen).resolves.toBe(uri);
  });

  it('clears the folder after a burst that reaches the cap, once nothing is downloading', async () => {
    const folder = generationFolder();
    for (let i = 0; i < VIDEO_POSTER_MAX_FILES - 1; i += 1) {
      disk.set(`${folder}/media-old-${i}.jpg`, 10);
    }
    const finishers = hold();
    const loads = ['v1', 'v2', 'v3'].map((guid) => loadVideoPoster(guid));
    await flush();
    finishers[0]!();
    await flush();

    // The cap is reached, but two downloads are still writing into the folder.
    expect(deletedDirs).toEqual([]);
    finishers[1]!();
    await flush();
    expect(deletedDirs).toEqual([]);

    finishers[2]!();
    await Promise.all(loads);
    await flush();
    expect(deletedDirs).toEqual([folder]);
    expect(postersOnDisk()).toBe(0);
  });

  it('never lets bursts of tiles grow the folder past the cap plus one queue', async () => {
    succeed();
    const ceiling = VIDEO_POSTER_MAX_FILES + VIDEO_POSTER_MAX_CONCURRENT + VIDEO_POSTER_MAX_WAITING;
    let largest = 0;
    for (let burst = 0; burst < 12; burst += 1) {
      const loads = Array.from({ length: 40 }, (_, i) => loadVideoPoster(`b${burst}-v${i}`));
      await Promise.all(loads);
      await flush();
      largest = Math.max(largest, postersOnDisk());
    }
    expect(mockDownload).toHaveBeenCalledTimes(480);
    expect(largest).toBeLessThanOrEqual(ceiling);
    expect(deletedDirs.length).toBeGreaterThan(0);
  });
});
