/**
 * Node-test adapter for the owned Android bounded downloader.
 *
 * Service tests already provide a tiny in-memory expo-file-system DownloadTask. Delegate to that
 * fake so they can keep exercising promotion, cancellation, timeout, and cleanup without loading
 * Expo's ESM native bridge in the plain ts-jest project. The real JS/native handshake has its own
 * direct test via a relative import of src/native/boundedDownload.ts.
 */
export type NativeBoundedDownloadFailure =
  'cancelled' | 'missing' | 'network' | 'size' | 'timeout' | 'unavailable';

export class NativeBoundedDownloadError extends Error {
  constructor(readonly reason: NativeBoundedDownloadFailure) {
    super(`native bounded download rejected: ${reason}`);
    this.name = 'NativeBoundedDownloadError';
  }
}

export const pruneNativeSyncedBackgroundCache = jest.fn(async (_keepUri: string | null) => ({
  withinQuota: true,
  deletedFiles: 0,
  deletedBytes: 0,
  remainingFiles: 0,
  remainingBytes: 0,
}));

export const deleteNativeSyncedBackgroundCacheFile = jest.fn(
  async (_uri: string): Promise<boolean> => true,
);

export const statNativeAttachmentCacheFile = jest.fn(async (_uri: string) => ({
  exists: false,
  bytes: 0,
}));

export const deleteNativeAttachmentCacheFile = jest.fn(async (_uri: string) => ({
  status: 'missing' as const,
  bytes: 0,
}));

export const adoptNativePastedAttachment = jest.fn(
  async (_sourceUri: string, destinationUri: string, expectedBytes: number) => ({
    uri: destinationUri,
    bytes: expectedBytes,
  }),
);

export const getNativeAttachmentCacheAvailableBytes = jest.fn(async (): Promise<number> => 0);

export const scanNativeAttachmentCacheFiles = jest.fn(async () => []);

interface MockOptions {
  url: string;
  destinationUri: string;
  headers?: Record<string, string>;
  maxBytes: number;
  timeoutMs: number;
  maxImagePixels?: number;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
}

export async function downloadNativeBoundedFile(options: MockOptions): Promise<{ bytes: number }> {
  // Individual suites install their own in-memory File implementation before this is invoked.
  const fileSystem = jest.requireMock('expo-file-system') as {
    File: new (uri: string) => {
      size: number;
      uri: string;
      constructor: {
        createDownloadTask: (
          url: string,
          destination: { size: number; uri: string },
          options: {
            headers?: Record<string, string>;
            signal?: AbortSignal;
            onProgress: (event: { bytesWritten: number; totalBytes: number }) => void;
          },
        ) => {
          cancel?: () => void;
          release?: () => void;
          downloadAsync: () => Promise<{ size: number; uri: string } | null>;
        };
      };
    };
  };
  const destination = new fileSystem.File(options.destinationUri);
  const createDownloadTask = (
    fileSystem.File as unknown as {
      createDownloadTask: (
        url: string,
        destination: { size: number; uri: string },
        options: {
          headers?: Record<string, string>;
          signal?: AbortSignal;
          onProgress: (event: { bytesWritten: number; totalBytes: number }) => void;
        },
      ) => {
        cancel?: () => void;
        release?: () => void;
        downloadAsync: () => Promise<{ size: number; uri: string } | null>;
      };
    }
  ).createDownloadTask;
  const task = createDownloadTask(options.url, destination, {
    headers: options.headers,
    signal: options.signal,
    onProgress: ({ bytesWritten, totalBytes }) => options.onProgress?.(bytesWritten, totalBytes),
  });
  const abort = (): void => task.cancel?.();
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const file = await task.downloadAsync();
    if (!file) throw new NativeBoundedDownloadError('missing');
    return { bytes: file.size };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    task.release?.();
  }
}
