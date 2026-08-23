/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
jest.mock('expo-file-system', () => {
  const disk = new Map<string, number>();
  const Directory = jest.fn(function (this: Record<string, unknown>, ...parts: string[]) {
    this.uri = parts.join('/');
    Object.defineProperty(this, 'exists', {
      configurable: true,
      get: () => [...disk.keys()].some((uri) => uri.startsWith(`${this.uri as string}/`)),
    });
    this.create = jest.fn();
    this.delete = jest.fn(() => {
      for (const uri of [...disk.keys()]) {
        if (uri.startsWith(`${this.uri as string}/`)) disk.delete(uri);
      }
    });
  });
  const File = jest.fn(function (
    this: Record<string, unknown>,
    directory: { uri: string } | string,
    name?: string,
  ) {
    const base = typeof directory === 'string' ? directory : directory.uri;
    this.uri = name == null ? base : `${base}/${name}`;
    Object.defineProperty(this, 'exists', {
      configurable: true,
      get: () => disk.has(this.uri as string),
    });
    Object.defineProperty(this, 'size', {
      configurable: true,
      get: () => disk.get(this.uri as string) ?? 0,
    });
    this.delete = jest.fn(() => disk.delete(this.uri as string));
    this.move = jest.fn(async (destination: { uri: string }) => {
      const source = this.uri as string;
      const bytes = disk.get(source);
      disk.delete(source);
      if (bytes != null) disk.set(destination.uri, bytes);
      this.uri = destination.uri;
    });
  }) as jest.Mock & {
    createDownloadTask: jest.Mock;
    mockDisk: Map<string, number>;
  };
  File.mockDisk = disk;
  File.createDownloadTask = jest.fn(
    (
      _url: string,
      destination: { uri: string },
      options?: { onProgress?: (progress: { bytesWritten: number; totalBytes: number }) => void },
    ) => ({
      cancel: jest.fn(),
      release: jest.fn(),
      downloadAsync: jest.fn(async () => {
        disk.set(destination.uri, 10);
        options?.onProgress?.({ bytesWritten: 10, totalBytes: 10 });
        return destination;
      }),
    }),
  );
  return {
    Paths: { cache: 'file:///cache', document: 'file:///documents' },
    Directory,
    File,
  };
});
jest.mock('@core/api', () => ({
  attachmentsApi: {
    attachmentDownloadUrl: jest.fn(
      (transport: { buildUrl(path: string): string }, guid: string, service?: string) =>
        transport.buildUrl(
          `${service === 'RCS' ? '/rcs' : ''}/attachment/${encodeURIComponent(guid)}/download`,
        ),
    ),
  },
}));

import { Directory, File } from 'expo-file-system';
import { AUTO_IMAGE_MAX_BYTES } from '@utils/attachment';
import {
  BoundedDownloadError,
  cancelAndDrainBoundedDownloads,
  cleanupAbandonedBoundedDownloadPartials,
} from '@/services/download/boundedNativeDownload';
import { expoFetcher } from '@/services/download/expoFetcher';

const MockDirectory = Directory as unknown as jest.Mock;
const MockFile = File as unknown as jest.Mock & {
  createDownloadTask: jest.Mock;
  mockDisk: Map<string, number>;
};

const http = {
  snapshotTransport: () => ({
    headers: { Authorization: 'Bearer secret' },
    buildUrl: (path: string) => `https://server.example/api/v1${path}`,
  }),
} as never;

beforeEach(() => {
  MockFile.mockDisk.clear();
  MockFile.createDownloadTask.mockClear();
  MockDirectory.mockClear();
});

describe('expoFetcher bounded account-generation destinations', () => {
  it('resolves the exact final quota path without creating a directory or starting native work', () => {
    const fetcher = expoFetcher(http);

    expect(fetcher.destinationUri?.('../attachment', 'photo/one.jpg', 71)).toBe(
      'file:///documents/attachments/media-..%2Fattachment/generation-71/media-photo%2Fone.jpg',
    );

    const directory = MockDirectory.mock.instances.at(-1) as unknown as { create: jest.Mock };
    expect(directory.create).not.toHaveBeenCalled();
    expect(MockFile.createDownloadTask).not.toHaveBeenCalled();
  });

  it('clears the dedicated temp directory once and never touches a completed .part filename', async () => {
    const abandoned = 'file:///cache/bounded-download-parts/abandoned.part';
    const legitimateFinal =
      'file:///documents/attachments/media-guid/generation-1/media-report.part';
    MockFile.mockDisk.set(abandoned, 4);
    MockFile.mockDisk.set(legitimateFinal, 8);

    // Simulate the new-runtime startup sweep after process death left one native partial behind.
    cleanupAbandonedBoundedDownloadPartials();

    const result = await expoFetcher(http).download('guid', 'report.part', undefined, null, 1);

    const rootIndex = MockDirectory.mock.calls.findIndex(
      (call) => call[0] === 'file:///cache' && call[1] === 'bounded-download-parts',
    );
    expect(rootIndex).toBeGreaterThanOrEqual(0);
    const root = MockDirectory.mock.instances[rootIndex] as unknown as {
      create: jest.Mock;
      delete: jest.Mock;
    };
    expect(root.delete).toHaveBeenCalledTimes(1);
    expect(root.create).toHaveBeenCalledWith({ intermediates: true, idempotent: true });
    expect(MockFile.mockDisk.has(abandoned)).toBe(false);
    expect(MockFile.mockDisk.get(legitimateFinal)).toBe(10);
    expect(result.localPath).toBe(legitimateFinal);
  });

  it('uses distinct collision-safe generation directories and promotes a unique cache temp', async () => {
    const fetcher = expoFetcher(http);

    const first = await fetcher.download('../attachment', 'photo/one.jpg', undefined, null, 71);
    const second = await fetcher.download('../attachment', 'photo/one.jpg', undefined, null, 72);

    expect(MockDirectory).toHaveBeenCalledWith(
      'file:///documents',
      'attachments',
      'media-..%2Fattachment',
      'generation-71',
    );
    expect(MockDirectory).toHaveBeenCalledWith(
      'file:///documents',
      'attachments',
      'media-..%2Fattachment',
      'generation-72',
    );
    expect(first.localPath).toContain('/generation-71/media-photo%2Fone.jpg');
    expect(second.localPath).toContain('/generation-72/media-photo%2Fone.jpg');
    expect(first.localPath).not.toBe(second.localPath);
    expect(first.bytes).toBe(10);
    expect(
      MockFile.mock.calls.some(
        (call) => String(call[1]).startsWith('request-') && String(call[1]).endsWith('.part'),
      ),
    ).toBe(true);
    expect(
      [...MockFile.mockDisk.keys()].some((uri) => uri.includes('/bounded-download-parts/')),
    ).toBe(false);
  });

  it('places deliberately unscoped callers in one stable safe namespace', async () => {
    const fetcher = expoFetcher(http);

    const first = await fetcher.download('attachment', 'one.jpg');
    const second = await fetcher.download('attachment', 'two.jpg');

    expect(
      MockDirectory.mock.calls.filter((call) => call[1] === 'attachments').map((call) => call[3]),
    ).toEqual(['generation-unscoped', 'generation-unscoped']);
    expect(first.localPath).toContain('/generation-unscoped/');
    expect(second.localPath).toContain('/generation-unscoped/');
    expect(MockFile.createDownloadTask).toHaveBeenCalledTimes(2);
  });

  it('cancels native streaming as soon as actual progress crosses the cap and removes the partial', async () => {
    const cancel = jest.fn();
    const release = jest.fn();
    MockFile.createDownloadTask.mockImplementationOnce(
      (
        _url: string,
        destination: { uri: string },
        options: {
          onProgress: (progress: { bytesWritten: number; totalBytes: number }) => void;
        },
      ) => ({
        cancel,
        release,
        downloadAsync: async () => {
          MockFile.mockDisk.set(destination.uri, AUTO_IMAGE_MAX_BYTES + 1);
          options.onProgress({ bytesWritten: AUTO_IMAGE_MAX_BYTES + 1, totalBytes: -1 });
          throw new Error('native cancelled');
        },
      }),
    );
    const fetcher = expoFetcher(http);
    const controller = new AbortController();

    await expect(
      fetcher.download('oversize', 'photo.jpg', undefined, null, 1, {
        mode: 'automatic',
        maxBytes: AUTO_IMAGE_MAX_BYTES,
        timeoutMs: 1000,
        signal: controller.signal,
      }),
    ).rejects.toEqual(expect.objectContaining<Partial<BoundedDownloadError>>({ reason: 'size' }));

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(
      [...MockFile.mockDisk.keys()].some(
        (uri) => uri.includes('media-oversize') || uri.includes('/bounded-download-parts/'),
      ),
    ).toBe(false);
  });

  it('cancels and drains every active native transfer before an account media sweep', async () => {
    let rejectDownload!: (error: Error) => void;
    const cancel = jest.fn(() => rejectDownload(new Error('native cancelled')));
    MockFile.createDownloadTask.mockImplementationOnce(() => ({
      cancel,
      release: jest.fn(),
      downloadAsync: () =>
        new Promise((_resolve, reject) => {
          rejectDownload = reject;
        }),
    }));
    const outcome = expoFetcher(http)
      .download('drain-me', 'photo.jpg', undefined, null, 9)
      .catch((error: unknown) => error);
    for (let i = 0; i < 10 && MockFile.createDownloadTask.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }

    await expect(cancelAndDrainBoundedDownloads(1_000)).resolves.toBe(true);
    await expect(outcome).resolves.toEqual(
      expect.objectContaining<Partial<BoundedDownloadError>>({ reason: 'cancelled' }),
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(
      [...MockFile.mockDisk.keys()].some((uri) => uri.includes('/bounded-download-parts/')),
    ).toBe(false);
  });

  it('rejects a false Content-Length after final stat and never promotes the partial', async () => {
    MockFile.createDownloadTask.mockImplementationOnce(
      (
        _url: string,
        destination: { uri: string },
        options: {
          onProgress: (progress: { bytesWritten: number; totalBytes: number }) => void;
        },
      ) => ({
        cancel: jest.fn(),
        release: jest.fn(),
        downloadAsync: async () => {
          MockFile.mockDisk.set(destination.uri, AUTO_IMAGE_MAX_BYTES + 1);
          options.onProgress({ bytesWritten: 1, totalBytes: 1 });
          return destination;
        },
      }),
    );
    const fetcher = expoFetcher(http);
    const controller = new AbortController();

    await expect(
      fetcher.download('false-length', 'photo.jpg', undefined, null, 1, {
        mode: 'automatic',
        maxBytes: AUTO_IMAGE_MAX_BYTES,
        timeoutMs: 1000,
        signal: controller.signal,
      }),
    ).rejects.toEqual(expect.objectContaining<Partial<BoundedDownloadError>>({ reason: 'size' }));

    expect(
      [...MockFile.mockDisk.keys()].some(
        (uri) => uri.includes('media-false-length') || uri.includes('/bounded-download-parts/'),
      ),
    ).toBe(false);
  });

  it('rejects an empty native file because Expo also uses size=0 for unreadable files', async () => {
    MockFile.createDownloadTask.mockImplementationOnce(
      (_url: string, destination: { uri: string }) => ({
        cancel: jest.fn(),
        release: jest.fn(),
        downloadAsync: async () => {
          MockFile.mockDisk.set(destination.uri, 0);
          return destination;
        },
      }),
    );
    const fetcher = expoFetcher(http);

    await expect(fetcher.download('empty', 'empty.jpg')).rejects.toEqual(
      expect.objectContaining<Partial<BoundedDownloadError>>({ reason: 'size' }),
    );
    expect([...MockFile.mockDisk.keys()].some((uri) => uri.includes('media-empty'))).toBe(false);
  });

  it('deletes a promoted final when the caller aborts during the awaited move', async () => {
    const controller = new AbortController();
    let finishMove!: () => void;
    MockFile.createDownloadTask.mockImplementationOnce(
      (_url: string, destination: { uri: string; move: jest.Mock }) => ({
        cancel: jest.fn(),
        release: jest.fn(),
        downloadAsync: async () => {
          MockFile.mockDisk.set(destination.uri, 10);
          const servicePartial = MockFile.mock.instances.find(
            (candidate) =>
              candidate !== destination &&
              (candidate as unknown as { uri: string }).uri === destination.uri,
          ) as unknown as { uri: string; move: jest.Mock };
          servicePartial.move.mockImplementationOnce(
            (final: { uri: string }) =>
              new Promise<void>((resolve) => {
                finishMove = () => {
                  MockFile.mockDisk.delete(destination.uri);
                  MockFile.mockDisk.set(final.uri, 10);
                  servicePartial.uri = final.uri;
                  resolve();
                };
              }),
          );
          return destination;
        },
      }),
    );
    const fetcher = expoFetcher(http);
    const run = fetcher.download('move-race', 'photo.jpg', undefined, null, 2, {
      mode: 'manual',
      maxBytes: 100,
      timeoutMs: 1000,
      signal: controller.signal,
    });
    for (let i = 0; i < 10 && finishMove == null; i += 1) await Promise.resolve();
    expect(finishMove).toBeDefined();

    controller.abort();
    finishMove();

    await expect(run).rejects.toEqual(
      expect.objectContaining<Partial<BoundedDownloadError>>({ reason: 'cancelled' }),
    );
    expect([...MockFile.mockDisk.keys()].some((uri) => uri.includes('media-move-race'))).toBe(
      false,
    );
  });

  it('deletes a promoted final when the absolute timeout expires during the awaited move', async () => {
    let finishMove!: () => void;
    MockFile.createDownloadTask.mockImplementationOnce(
      (_url: string, destination: { uri: string; move: jest.Mock }) => ({
        cancel: jest.fn(),
        release: jest.fn(),
        downloadAsync: async () => {
          MockFile.mockDisk.set(destination.uri, 10);
          const servicePartial = MockFile.mock.instances.find(
            (candidate) =>
              candidate !== destination &&
              (candidate as unknown as { uri: string }).uri === destination.uri,
          ) as unknown as { uri: string; move: jest.Mock };
          servicePartial.move.mockImplementationOnce(
            (final: { uri: string }) =>
              new Promise<void>((resolve) => {
                finishMove = () => {
                  MockFile.mockDisk.delete(destination.uri);
                  MockFile.mockDisk.set(final.uri, 10);
                  servicePartial.uri = final.uri;
                  resolve();
                };
              }),
          );
          return destination;
        },
      }),
    );
    const fetcher = expoFetcher(http);
    const controller = new AbortController();
    jest.useFakeTimers();
    try {
      const run = fetcher.download('move-timeout', 'photo.jpg', undefined, null, 2, {
        mode: 'manual',
        maxBytes: 100,
        timeoutMs: 1000,
        signal: controller.signal,
      });
      for (let i = 0; i < 10 && finishMove == null; i += 1) await Promise.resolve();
      expect(finishMove).toBeDefined();

      await jest.advanceTimersByTimeAsync(1000);
      finishMove();

      await expect(run).rejects.toEqual(
        expect.objectContaining<Partial<BoundedDownloadError>>({ reason: 'timeout' }),
      );
      expect([...MockFile.mockDisk.keys()].some((uri) => uri.includes('media-move-timeout'))).toBe(
        false,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('cleans a partial even when native task construction itself throws', async () => {
    MockFile.createDownloadTask.mockImplementationOnce(
      (_url: string, destination: { uri: string }) => {
        MockFile.mockDisk.set(destination.uri, 4);
        throw new Error('native constructor failed');
      },
    );
    const fetcher = expoFetcher(http);

    await expect(fetcher.download('constructor-failure', 'photo.jpg')).rejects.toThrow(
      'native constructor failed',
    );
    expect(
      [...MockFile.mockDisk.keys()].some((uri) => uri.includes('media-constructor-failure')),
    ).toBe(false);
  });

  it('leaves a previously completed final file intact when a replacement transfer fails', async () => {
    MockFile.createDownloadTask.mockImplementationOnce(
      (_url: string, destination: { uri: string }) => ({
        cancel: jest.fn(),
        release: jest.fn(),
        downloadAsync: async () => {
          MockFile.mockDisk.set(destination.uri, 3);
          throw new Error('network failed');
        },
      }),
    );
    const fetcher = expoFetcher(http);
    const finalUri = 'file:///documents/attachments/media-replacement/generation-3/media-photo.jpg';
    MockFile.mockDisk.set(finalUri, 8);

    await expect(fetcher.download('replacement', 'photo.jpg', undefined, null, 3)).rejects.toThrow(
      'network failed',
    );

    expect(MockFile.mockDisk.get(finalUri)).toBe(8);
    expect(
      [...MockFile.mockDisk.keys()].some((uri) => uri.includes('/bounded-download-parts/')),
    ).toBe(false);
  });
});
