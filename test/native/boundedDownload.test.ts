const progressListeners = new Set<
  (event: { requestId: string; loaded: number; total: number }) => void
>();
const native = {
  prepare: jest.fn(),
  cancel: jest.fn(),
  releasePrepared: jest.fn(),
  download: jest.fn(),
  pruneSyncedBackgroundCache: jest.fn(),
  deleteSyncedBackgroundCacheFile: jest.fn(),
  statAttachmentCacheFile: jest.fn(),
  deleteAttachmentCacheFile: jest.fn(),
  adoptPastedAttachment: jest.fn(),
  getAttachmentCacheAvailableBytes: jest.fn(),
  beginAttachmentCacheScan: jest.fn(),
  nextAttachmentCacheScanPage: jest.fn(),
  closeAttachmentCacheScan: jest.fn(),
  addListener: jest.fn(
    (
      _event: string,
      listener: (event: { requestId: string; loaded: number; total: number }) => void,
    ) => {
      progressListeners.add(listener);
      return { remove: () => progressListeners.delete(listener) };
    },
  ),
};
const moduleRef: { current: typeof native | null } = { current: native };

jest.mock('expo', () => ({
  requireOptionalNativeModule: () => moduleRef.current,
}));

// Relative import deliberately bypasses Jest's @native production-boundary mapper.
// eslint-disable-next-line import/first
import {
  adoptNativePastedAttachment,
  deleteNativeAttachmentCacheFile,
  downloadNativeBoundedFile,
  deleteNativeSyncedBackgroundCacheFile,
  getNativeAttachmentCacheAvailableBytes,
  NativeBoundedDownloadError,
  pruneNativeSyncedBackgroundCache,
  scanNativeAttachmentCacheFiles,
  statNativeAttachmentCacheFile,
} from '../../src/native/boundedDownload';

beforeEach(() => {
  moduleRef.current = native;
  progressListeners.clear();
  native.prepare.mockReset();
  native.cancel.mockReset();
  native.releasePrepared.mockReset();
  native.download.mockReset().mockResolvedValue({ ok: true, bytes: 25 });
  native.pruneSyncedBackgroundCache.mockReset().mockResolvedValue({
    ok: true,
    withinQuota: true,
    deletedFiles: 2,
    deletedBytes: 20,
    remainingFiles: 3,
    remainingBytes: 30,
  });
  native.deleteSyncedBackgroundCacheFile.mockReset().mockResolvedValue(true);
  native.statAttachmentCacheFile.mockReset().mockResolvedValue({
    ok: true,
    exists: true,
    bytes: 42,
  });
  native.deleteAttachmentCacheFile.mockReset().mockResolvedValue({
    ok: true,
    status: 'deleted',
    bytes: 42,
  });
  native.adoptPastedAttachment
    .mockReset()
    .mockImplementation(
      async (_sourceUri: string, destinationUri: string, expectedBytes: number) => ({
        ok: true,
        uri: destinationUri,
        bytes: expectedBytes,
      }),
    );
  native.getAttachmentCacheAvailableBytes.mockReset().mockResolvedValue({
    ok: true,
    availableBytes: 1_024,
  });
  native.beginAttachmentCacheScan.mockReset().mockResolvedValue({
    ok: true,
    scanId: 'opaque-scan-id',
  });
  native.nextAttachmentCacheScanPage.mockReset().mockResolvedValue({
    ok: true,
    done: true,
    overflow: false,
    files: [],
  });
  native.closeAttachmentCacheScan.mockReset().mockResolvedValue({ ok: true, closed: false });
  native.addListener.mockClear();
});

it('prepares synchronously, forwards only its own progress, and removes the listener', async () => {
  const progress = jest.fn();
  native.download.mockImplementationOnce(async (requestId: string) => {
    progressListeners.forEach((listener) =>
      listener({ requestId: 'another', loaded: 1, total: 2 }),
    );
    progressListeners.forEach((listener) => listener({ requestId, loaded: 10, total: 25 }));
    return { ok: true, bytes: 25 };
  });

  await expect(
    downloadNativeBoundedFile({
      url: 'https://server.test/file',
      destinationUri: 'file:///private/file.part',
      maxBytes: 100,
      timeoutMs: 1_000,
      maxImagePixels: 12_000_000,
      onProgress: progress,
    }),
  ).resolves.toEqual({ bytes: 25 });

  expect(native.prepare).toHaveBeenCalledTimes(1);
  expect(native.prepare.mock.invocationCallOrder[0]).toBeLessThan(
    native.download.mock.invocationCallOrder[0]!,
  );
  expect(progress).toHaveBeenCalledWith(10, 25);
  expect(progress).toHaveBeenCalledTimes(1);
  expect(native.download).toHaveBeenCalledWith(
    expect.any(String),
    'https://server.test/file',
    'file:///private/file.part',
    {},
    100,
    1_000,
    12_000_000,
  );
  expect(progressListeners.size).toBe(0);
});

it('cancels the prepared native request when the AbortSignal fires', async () => {
  const controller = new AbortController();
  let finish!: () => void;
  native.download.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ ok: false, reason: 'cancelled' });
      }),
  );
  const run = downloadNativeBoundedFile({
    url: 'https://server.test/file',
    destinationUri: 'file:///private/file.part',
    maxBytes: 100,
    timeoutMs: 1_000,
    signal: controller.signal,
  });
  await Promise.resolve();
  controller.abort();
  const requestId = native.prepare.mock.calls[0]![0] as string;
  expect(native.cancel).toHaveBeenCalledWith(requestId);
  finish();
  await expect(run).rejects.toEqual(
    expect.objectContaining<Partial<NativeBoundedDownloadError>>({ reason: 'cancelled' }),
  );
});

it('fails closed when the owned native module is unavailable', async () => {
  moduleRef.current = null;
  await expect(
    downloadNativeBoundedFile({
      url: 'https://server.test/file',
      destinationUri: 'file:///private/file.part',
      maxBytes: 100,
      timeoutMs: 1_000,
    }),
  ).rejects.toEqual(
    expect.objectContaining<Partial<NativeBoundedDownloadError>>({ reason: 'unavailable' }),
  );
});

it('releases a prepared request when listener setup fails before download starts', async () => {
  native.addListener.mockImplementationOnce(() => {
    throw new Error('listener bridge failed');
  });

  await expect(
    downloadNativeBoundedFile({
      url: 'https://server.test/file',
      destinationUri: 'file:///private/file.part',
      maxBytes: 100,
      timeoutMs: 1_000,
    }),
  ).rejects.toThrow('listener bridge failed');

  const requestId = native.prepare.mock.calls[0]![0] as string;
  expect(native.releasePrepared).toHaveBeenCalledWith(requestId);
  expect(native.download).not.toHaveBeenCalled();
});

it('releases a prepared request when the download bridge call throws synchronously', async () => {
  native.download.mockImplementationOnce(() => {
    throw new Error('download bridge failed');
  });

  await expect(
    downloadNativeBoundedFile({
      url: 'https://server.test/file',
      destinationUri: 'file:///private/file.part',
      maxBytes: 100,
      timeoutMs: 1_000,
    }),
  ).rejects.toThrow('download bridge failed');

  const requestId = native.prepare.mock.calls[0]![0] as string;
  expect(native.releasePrepared).toHaveBeenCalledWith(requestId);
});

it('still tears down native request state when listener removal throws', async () => {
  native.addListener.mockImplementationOnce(() => ({
    remove: () => {
      throw new Error('listener removal failed');
    },
  }));

  await expect(
    downloadNativeBoundedFile({
      url: 'https://server.test/file',
      destinationUri: 'file:///private/file.part',
      maxBytes: 100,
      timeoutMs: 1_000,
    }),
  ).resolves.toEqual({ bytes: 25 });

  const requestId = native.prepare.mock.calls[0]![0] as string;
  expect(native.cancel).toHaveBeenCalledWith(requestId);
});

it('rejects a malformed native success instead of trusting it', async () => {
  native.download.mockResolvedValueOnce({ ok: true, bytes: 0 });
  await expect(
    downloadNativeBoundedFile({
      url: 'https://server.test/file',
      destinationUri: 'file:///private/file.part',
      maxBytes: 100,
      timeoutMs: 1_000,
    }),
  ).rejects.toEqual(
    expect.objectContaining<Partial<NativeBoundedDownloadError>>({ reason: 'size' }),
  );
});

it('requests the fixed native synced-background prune with only the protected URI', async () => {
  const keepUri = 'file:///private/synced-backgrounds/generation-7/media-current.jpg';

  await expect(pruneNativeSyncedBackgroundCache(keepUri)).resolves.toEqual({
    withinQuota: true,
    deletedFiles: 2,
    deletedBytes: 20,
    remainingFiles: 3,
    remainingBytes: 30,
  });

  expect(native.pruneSyncedBackgroundCache).toHaveBeenCalledWith(keepUri);
});

it('delegates old-wallpaper deletion to the fixed native ownership boundary', async () => {
  const uri = 'file:///private/synced-backgrounds/generation-7/media-old.jpg';

  await expect(deleteNativeSyncedBackgroundCacheFile(uri)).resolves.toBe(true);

  expect(native.deleteSyncedBackgroundCacheFile).toHaveBeenCalledWith(uri);
  native.deleteSyncedBackgroundCacheFile.mockResolvedValueOnce('yes');
  await expect(deleteNativeSyncedBackgroundCacheFile(uri)).rejects.toEqual(
    expect.objectContaining<Partial<NativeBoundedDownloadError>>({ reason: 'unavailable' }),
  );
});

it('accepts a temporary recent-file overage but rejects malformed prune statistics', async () => {
  native.pruneSyncedBackgroundCache.mockResolvedValueOnce({
    ok: true,
    withinQuota: false,
    deletedFiles: 0,
    deletedBytes: 0,
    remainingFiles: 11,
    remainingBytes: 110,
  });
  await expect(pruneNativeSyncedBackgroundCache(null)).resolves.toEqual({
    withinQuota: false,
    deletedFiles: 0,
    deletedBytes: 0,
    remainingFiles: 11,
    remainingBytes: 110,
  });

  native.pruneSyncedBackgroundCache.mockResolvedValueOnce({
    ok: true,
    withinQuota: true,
    deletedFiles: -1,
    deletedBytes: 0,
    remainingFiles: 0,
    remainingBytes: 0,
  });
  await expect(pruneNativeSyncedBackgroundCache(null)).rejects.toEqual(
    expect.objectContaining<Partial<NativeBoundedDownloadError>>({ reason: 'unavailable' }),
  );
});

it('stats only the exact attachment-cache URI and validates missing-file accounting', async () => {
  const uri = 'file:///private/attachments/guid/generation/media.jpg';

  await expect(statNativeAttachmentCacheFile(uri)).resolves.toEqual({
    exists: true,
    bytes: 42,
  });
  expect(native.statAttachmentCacheFile).toHaveBeenCalledWith(uri);
  expect(native.statAttachmentCacheFile.mock.calls[0]).toHaveLength(1);

  native.statAttachmentCacheFile.mockResolvedValueOnce({
    ok: true,
    exists: false,
    bytes: 0,
  });
  await expect(statNativeAttachmentCacheFile(uri)).resolves.toEqual({
    exists: false,
    bytes: 0,
  });

  native.statAttachmentCacheFile.mockResolvedValueOnce({
    ok: true,
    exists: false,
    bytes: 5,
  });
  await expect(statNativeAttachmentCacheFile(uri)).rejects.toEqual(
    expect.objectContaining<Partial<NativeBoundedDownloadError>>({ reason: 'unavailable' }),
  );
});

it.each([
  { ok: false, exists: true, bytes: 42 },
  { ok: true, exists: 'yes', bytes: 42 },
  { ok: true, exists: true, bytes: -1 },
  { ok: true, exists: true, bytes: 1.5 },
  { ok: true, exists: true, bytes: Number.MAX_SAFE_INTEGER + 1 },
])('rejects malformed attachment-cache stat result %#', async (result) => {
  native.statAttachmentCacheFile.mockResolvedValueOnce(result);

  await expect(statNativeAttachmentCacheFile('file:///private/attachments/file')).rejects.toEqual(
    expect.objectContaining<Partial<NativeBoundedDownloadError>>({ reason: 'unavailable' }),
  );
});

it('collects a complete bounded attachment-cache manifest and closes its opaque session', async () => {
  const first = {
    uri: 'file:///private/attachments/media-a/generation-1/media-a.jpg',
    bytes: 12,
    mtimeMs: 100,
  };
  const second = {
    uri: 'file:///private/attachments/media-b/generation-1/media-b.jpg',
    bytes: 34,
    mtimeMs: 200,
  };
  native.nextAttachmentCacheScanPage
    .mockResolvedValueOnce({ ok: true, done: false, overflow: false, files: [first] })
    .mockResolvedValueOnce({ ok: true, done: true, overflow: false, files: [second] });

  await expect(scanNativeAttachmentCacheFiles()).resolves.toEqual([first, second]);
  expect(native.beginAttachmentCacheScan).toHaveBeenCalledWith();
  expect(native.nextAttachmentCacheScanPage).toHaveBeenNthCalledWith(1, 'opaque-scan-id');
  expect(native.nextAttachmentCacheScanPage).toHaveBeenNthCalledWith(2, 'opaque-scan-id');
  expect(native.closeAttachmentCacheScan).toHaveBeenCalledWith('opaque-scan-id');
});

it('returns no partial manifest when a later native scan page is malformed', async () => {
  native.nextAttachmentCacheScanPage
    .mockResolvedValueOnce({
      ok: true,
      done: false,
      overflow: false,
      files: [
        {
          uri: 'file:///private/attachments/media-a/generation-1/media-a.jpg',
          bytes: 12,
          mtimeMs: 100,
        },
      ],
    })
    .mockResolvedValueOnce({ ok: true, done: true, overflow: true, files: [] });

  await expect(scanNativeAttachmentCacheFiles()).rejects.toEqual(
    expect.objectContaining<Partial<NativeBoundedDownloadError>>({ reason: 'unavailable' }),
  );
  expect(native.closeAttachmentCacheScan).toHaveBeenCalledWith('opaque-scan-id');
});

it.each([
  { ok: false, done: true, overflow: false, files: [] },
  { ok: true, done: 'yes', overflow: false, files: [] },
  { ok: true, done: true, overflow: undefined, files: [] },
  { ok: true, done: true, overflow: false, files: 'not-an-array' },
  {
    ok: true,
    done: true,
    overflow: false,
    files: [{ uri: '', bytes: 1, mtimeMs: 1 }],
  },
  {
    ok: true,
    done: true,
    overflow: false,
    files: [{ uri: 'file:///private/a', bytes: -1, mtimeMs: 1 }],
  },
  {
    ok: true,
    done: true,
    overflow: false,
    files: [{ uri: 'file:///private/a', bytes: 1, mtimeMs: Number.NaN }],
  },
])('rejects malformed attachment-cache scan page %#', async (page) => {
  native.nextAttachmentCacheScanPage.mockResolvedValueOnce(page);

  await expect(scanNativeAttachmentCacheFiles()).rejects.toEqual(
    expect.objectContaining<Partial<NativeBoundedDownloadError>>({ reason: 'unavailable' }),
  );
});

it('rejects duplicate attachment-cache scan URIs across pages', async () => {
  const file = {
    uri: 'file:///private/attachments/media-a/generation-1/media-a.jpg',
    bytes: 12,
    mtimeMs: 100,
  };
  native.nextAttachmentCacheScanPage
    .mockResolvedValueOnce({ ok: true, done: false, overflow: false, files: [file] })
    .mockResolvedValueOnce({ ok: true, done: true, overflow: false, files: [file] });

  await expect(scanNativeAttachmentCacheFiles()).rejects.toEqual(
    expect.objectContaining<Partial<NativeBoundedDownloadError>>({ reason: 'unavailable' }),
  );
});

it.each([
  { ok: false, scanId: 'opaque-scan-id' },
  { ok: true, scanId: '' },
  { ok: true, scanId: 'x'.repeat(81) },
])('rejects malformed attachment-cache scan begin result %#', async (begin) => {
  native.beginAttachmentCacheScan.mockResolvedValueOnce(begin);

  await expect(scanNativeAttachmentCacheFiles()).rejects.toEqual(
    expect.objectContaining<Partial<NativeBoundedDownloadError>>({ reason: 'unavailable' }),
  );
  expect(native.nextAttachmentCacheScanPage).not.toHaveBeenCalled();
  expect(native.closeAttachmentCacheScan).not.toHaveBeenCalled();
});

it('distinguishes deleted and already-missing attachment-cache files', async () => {
  const uri = 'file:///private/attachments/guid/generation/media.jpg';

  await expect(deleteNativeAttachmentCacheFile(uri)).resolves.toEqual({
    status: 'deleted',
    bytes: 42,
  });
  expect(native.deleteAttachmentCacheFile).toHaveBeenCalledWith(uri);
  expect(native.deleteAttachmentCacheFile.mock.calls[0]).toHaveLength(1);

  native.deleteAttachmentCacheFile.mockResolvedValueOnce({
    ok: true,
    status: 'missing',
    bytes: 0,
  });
  await expect(deleteNativeAttachmentCacheFile(uri)).resolves.toEqual({
    status: 'missing',
    bytes: 0,
  });
});

it('adopts one exact pasted file only when native returns the reserved destination and size', async () => {
  const source = 'file:///private/cache/pasted-in/1000-1/photo.jpg';
  const destination = 'file:///private/files/attachments/media-temp/generation-7/media-photo.jpg';

  await expect(adoptNativePastedAttachment(source, destination, 42)).resolves.toEqual({
    uri: destination,
    bytes: 42,
  });
  expect(native.adoptPastedAttachment).toHaveBeenCalledWith(source, destination, 42);

  native.adoptPastedAttachment.mockResolvedValueOnce({
    ok: true,
    uri: `${destination}.other`,
    bytes: 42,
  });
  await expect(adoptNativePastedAttachment(source, destination, 42)).rejects.toEqual(
    expect.objectContaining<Partial<NativeBoundedDownloadError>>({ reason: 'unavailable' }),
  );

  await expect(adoptNativePastedAttachment(source, destination, 0)).rejects.toEqual(
    expect.objectContaining<Partial<NativeBoundedDownloadError>>({ reason: 'size' }),
  );
});

it.each([
  { ok: false, status: 'deleted', bytes: 42 },
  { ok: true, status: 'other', bytes: 42 },
  { ok: true, status: 'missing', bytes: 1 },
  { ok: true, status: 'deleted', bytes: -1 },
  { ok: true, status: 'deleted', bytes: 1.5 },
  { ok: true, status: 'deleted', bytes: Number.MAX_SAFE_INTEGER + 1 },
])('rejects malformed attachment-cache delete result %#', async (result) => {
  native.deleteAttachmentCacheFile.mockResolvedValueOnce(result);

  await expect(deleteNativeAttachmentCacheFile('file:///private/attachments/file')).rejects.toEqual(
    expect.objectContaining<Partial<NativeBoundedDownloadError>>({ reason: 'unavailable' }),
  );
});

it('reads native attachment-cache free space without accepting a caller-selected root', async () => {
  await expect(getNativeAttachmentCacheAvailableBytes()).resolves.toBe(1_024);
  expect(native.getAttachmentCacheAvailableBytes).toHaveBeenCalledWith();
});

it.each([
  { ok: false, availableBytes: 1_024 },
  { ok: true, availableBytes: -1 },
  { ok: true, availableBytes: 1.5 },
  { ok: true, availableBytes: Number.MAX_SAFE_INTEGER + 1 },
])('rejects malformed attachment-cache available-byte result %#', async (result) => {
  native.getAttachmentCacheAvailableBytes.mockResolvedValueOnce(result);

  await expect(getNativeAttachmentCacheAvailableBytes()).rejects.toEqual(
    expect.objectContaining<Partial<NativeBoundedDownloadError>>({ reason: 'unavailable' }),
  );
});
