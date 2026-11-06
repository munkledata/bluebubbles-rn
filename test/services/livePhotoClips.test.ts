/**
 * loadLivePhotoClip (src/services/download/livePhotoClips.ts): fetches a Live Photo's motion clip
 * from the server's /live route, by the still's guid, through the bounded native downloader,
 * saves it under the account generation's folder, and remembers a "no clip" answer. The native
 * download and the filesystem are mocked in-file; the real delivery coordinator supplies leases.
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
  LIVE_PHOTO_CLIP_MAX_BYTES,
  LIVE_PHOTO_CLIP_MAX_FILES,
  LIVE_PHOTO_CLIP_TIMEOUT_MS,
  loadLivePhotoClip,
  resetLivePhotoClipsForTests,
} from '@/services/download/livePhotoClips';
// eslint-disable-next-line import/first
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
// eslint-disable-next-line import/first
import { attachmentLivePhotoUrl } from '@core/api/endpoints/attachments';

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
  maxImagePixels?: number;
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
    disk.set(options.destination.uri, 3_500_000);
    return { file: options.destination, bytes: 3_500_000 };
  });
}

function generationFolder(): string {
  return `file:///doc/live-photo-clips/generation-${captureRealtimeDeliveryLease().generation}`;
}

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
  resetLivePhotoClipsForTests();
  resumeRealtimeDeliveries();
});

describe('attachmentLivePhotoUrl', () => {
  it("is the still's /live route with the guid encoded", () => {
    const builder = { buildUrl: (path: string) => `https://s/api/v1${path}` };
    expect(attachmentLivePhotoUrl(builder, 'at_0/AB+C')).toBe(
      'https://s/api/v1/attachment/at_0%2FAB%2BC/live',
    );
  });
});

describe('loadLivePhotoClip', () => {
  it('downloads the clip once, bounded, into the account folder, then reuses it', async () => {
    succeed();
    const uri = await loadLivePhotoClip('still-1');
    expect(uri).toBe(`${generationFolder()}/media-still-1.mov`);
    const call = lastCall();
    expect(call.url).toBe('https://server/api/v1/attachment/still-1/live');
    expect(call.headers).toEqual({ Authorization: 'Bearer x' });
    expect(call.maxBytes).toBe(LIVE_PHOTO_CLIP_MAX_BYTES);
    expect(call.timeoutMs).toBe(LIVE_PHOTO_CLIP_TIMEOUT_MS);
    expect(call.maxImagePixels).toBeUndefined();

    await expect(loadLivePhotoClip('still-1')).resolves.toBe(uri);
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it('shares one download between two holds that overlap', async () => {
    let finish!: () => void;
    mockDownload.mockImplementation(
      (options: DownloadCall) =>
        new Promise((resolve) => {
          finish = () => {
            disk.set(options.destination.uri, 10);
            resolve({ file: options.destination, bytes: 10 });
          };
        }),
    );
    const first = loadLivePhotoClip('still-1');
    const second = loadLivePhotoClip('still-1');
    await flush();
    finish();
    const [a, b] = await Promise.all([first, second]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it('remembers a still with no clip (404) and an oversized one, and never asks again', async () => {
    mockDownload.mockRejectedValueOnce(new BoundedDownloadError('missing'));
    mockDownload.mockRejectedValueOnce(new BoundedDownloadError('size'));
    await expect(loadLivePhotoClip('no-clip')).resolves.toBeNull();
    await expect(loadLivePhotoClip('huge')).resolves.toBeNull();
    await expect(loadLivePhotoClip('no-clip')).resolves.toBeNull();
    await expect(loadLivePhotoClip('huge')).resolves.toBeNull();
    expect(mockDownload).toHaveBeenCalledTimes(2);
  });

  it('asks again after a passing failure', async () => {
    mockDownload.mockRejectedValueOnce(new BoundedDownloadError('timeout'));
    await expect(loadLivePhotoClip('still-1')).resolves.toBeNull();
    succeed();
    await expect(loadLivePhotoClip('still-1')).resolves.not.toBeNull();
    expect(mockDownload).toHaveBeenCalledTimes(2);
  });

  it('replace drops a saved clip that failed to play and fetches it again', async () => {
    succeed();
    const uri = await loadLivePhotoClip('still-1');
    await expect(loadLivePhotoClip('still-1', true)).resolves.toBe(uri);
    expect(mockDelete).toHaveBeenCalled();
    expect(mockDownload).toHaveBeenCalledTimes(2);
  });

  it('keeps nothing from an account that disconnects mid-download', async () => {
    let finish!: () => void;
    mockDownload.mockImplementationOnce(
      (options: DownloadCall) =>
        new Promise((resolve) => {
          finish = () => {
            disk.set(options.destination.uri, 10);
            resolve({ file: options.destination, bytes: 10 });
          };
        }),
    );
    const pending = loadLivePhotoClip('still-1');
    await flush();
    const oldDestination = lastCall().destination.uri;
    expect(lastCall().shouldContinue()).toBe(true);
    await pauseRealtimeDeliveries();
    expect(lastCall().shouldContinue()).toBe(false);
    finish();
    await expect(pending).resolves.toBeNull();
    expect(disk.has(oldDestination)).toBe(false);
    // While no account is current, nothing is fetched at all.
    await expect(loadLivePhotoClip('still-1')).resolves.toBeNull();
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it('a stale transport never keeps the clip', async () => {
    mockDownload.mockImplementationOnce(async (options: DownloadCall) => {
      disk.set(options.destination.uri, 10);
      mockTransportCurrent.value = false;
      return { file: options.destination, bytes: 10 };
    });
    await expect(loadLivePhotoClip('still-1')).resolves.toBeNull();
    expect(postedFiles()).toBe(0);
  });

  it('clears the folder once it holds the cap, before the next download', async () => {
    succeed();
    for (let i = 0; i < LIVE_PHOTO_CLIP_MAX_FILES; i += 1) {
      await loadLivePhotoClip(`still-${String(i)}`);
    }
    expect(postedFiles()).toBe(LIVE_PHOTO_CLIP_MAX_FILES);
    await loadLivePhotoClip('one-more');
    expect(deletedDirs).toEqual([generationFolder()]);
    expect(postedFiles()).toBe(1);
  });

  it('an empty guid asks for nothing', async () => {
    await expect(loadLivePhotoClip('')).resolves.toBeNull();
    expect(mockDownload).not.toHaveBeenCalled();
  });
});

function postedFiles(): number {
  return [...disk.keys()].filter((uri) => uri.startsWith(`${generationFolder()}/`)).length;
}
