const mockGetInfoAsync = jest.fn();
const mockCreateUploadTask = jest.fn();
const mockCancelAsync = jest.fn(async () => undefined);
const mockRemoveSubscription = jest.fn();
const mockUploadStart = jest.fn();
const mockUploadProgress = jest.fn();
const mockUploadSettle = jest.fn();
const mockUploadAsync = jest.fn(async () => ({
  status: 200,
  body: JSON.stringify({ status: 200, data: { guid: 'server-message' } }),
}));
type MockUploadSuccess = Awaited<ReturnType<typeof mockUploadAsync>>;

jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: mockGetInfoAsync,
  createUploadTask: mockCreateUploadTask,
  FileSystemUploadType: { MULTIPART: 1 },
}));
jest.mock('@state/uploadStore', () => ({
  uploadStoreSink: {
    start: mockUploadStart,
    progress: mockUploadProgress,
    settle: mockUploadSettle,
  },
}));
jest.mock('@ui/toast/toastStore', () => ({ showToast: jest.fn() }));

// Mocks must be registered before these modules evaluate their native imports.
// eslint-disable-next-line import/first
import { HttpClient } from '@core/api/http';
// eslint-disable-next-line import/first
import { logger } from '@core/secure';
// eslint-disable-next-line import/first
import { expoAttachmentUploader } from '@/services/send/attachmentUpload';
// eslint-disable-next-line import/first
import { uploadGate, uploadRegistry } from '@/services/send/uploadControl';

let finishFileCheck!: (value: { exists: boolean }) => void;

beforeEach(() => {
  uploadRegistry.cancelAll();
  jest.clearAllMocks();
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  mockGetInfoAsync.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishFileCheck = resolve;
      }),
  );
  mockCreateUploadTask.mockReturnValue({
    uploadAsync: mockUploadAsync,
    cancelAsync: mockCancelAsync,
    removeSubscription: mockRemoveSubscription,
  });
});

afterEach(() => {
  uploadRegistry.cancelAll();
  jest.restoreAllMocks();
});

function upload(
  http: HttpClient,
  options: { timeoutMs?: number } = {},
): ReturnType<typeof expoAttachmentUploader> {
  return expoAttachmentUploader({
    http,
    chatGuid: 'chat-1',
    tempGuid: 'temp-1',
    attachmentGuid: 'att-1',
    name: 'photo.jpg',
    uri: 'file:///photo.jpg',
    mimeType: 'image/jpeg',
    totalBytes: 42,
    timeoutMs: options.timeoutMs,
  });
}

async function flushMicrotasks(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

describe('native attachment upload account scope', () => {
  it('keeps the original URL and credential when the live account changes during preflight', async () => {
    let origin = 'https://old.example';
    let password = 'old-password';
    const http = new HttpClient({
      getOrigin: () => origin,
      getPassword: () => password,
    });

    const run = upload(http);
    expect(mockGetInfoAsync).toHaveBeenCalledWith('file:///photo.jpg');
    expect(uploadRegistry.size).toBe(1);

    origin = 'https://new.example';
    password = 'new-password';
    finishFileCheck({ exists: true });
    await expect(run).resolves.toMatchObject({ guid: 'server-message' });

    expect(mockCreateUploadTask).toHaveBeenCalledTimes(1);
    const [url, , options] = mockCreateUploadTask.mock.calls[0]!;
    expect(url).toBe('https://old.example/api/v1/message/attachment/upload');
    expect(options.headers.Authorization).toBe('Bearer old-password');
    expect(options.headers.Authorization).not.toContain('new-password');
    expect(uploadRegistry.size).toBe(0);
  });

  it('Disconnect cancellation during file preflight prevents the native task from starting', async () => {
    const http = new HttpClient({
      getOrigin: () => 'https://old.example',
      getPassword: () => 'old-password',
    });

    const run = upload(http);
    expect(uploadRegistry.size).toBe(1);
    expect(uploadRegistry.cancelAll()).toBe(1);
    finishFileCheck({ exists: true });

    await expect(run).rejects.toMatchObject({ kind: 'cancelled' });
    expect(mockCreateUploadTask).not.toHaveBeenCalled();
    expect(uploadRegistry.size).toBe(0);
  });

  it('bounds a stuck file preflight and never starts a native upload', async () => {
    jest.useFakeTimers();
    try {
      const http = new HttpClient({
        getOrigin: () => 'https://old.example',
        getPassword: () => 'old-password',
      });
      const run = upload(http, { timeoutMs: 60_000 });

      jest.advanceTimersByTime(60_000);
      await expect(run).rejects.toMatchObject({ kind: 'timeout' });
      expect(mockCreateUploadTask).not.toHaveBeenCalled();
      expect(mockUploadStart).not.toHaveBeenCalled();
      expect(uploadRegistry.size).toBe(0);

      // Let the ignored native stat unwind so it cannot leak work into the next test.
      finishFileCheck({ exists: true });
      await flushMicrotasks();
    } finally {
      jest.useRealTimers();
    }
  });

  it('times out one active native task, settles UI, and retains its slot/handle until native settles', async () => {
    jest.useFakeTimers();
    let finishNativeUpload!: (value: MockUploadSuccess) => void;
    try {
      mockUploadAsync.mockImplementationOnce(
        () =>
          new Promise<MockUploadSuccess>((resolve) => {
            finishNativeUpload = resolve;
          }),
      );
      const http = new HttpClient({
        getOrigin: () => 'https://old.example',
        getPassword: () => 'old-password',
      });
      const run = upload(http, { timeoutMs: 60_000 });
      finishFileCheck({ exists: true });
      await flushMicrotasks();
      expect(mockCreateUploadTask).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(60_000);
      await expect(run).rejects.toMatchObject({ kind: 'timeout' });
      expect(mockCancelAsync).toHaveBeenCalledTimes(1);
      expect(mockUploadSettle).toHaveBeenCalledTimes(1);
      // Still one real native promise and gate slot; keep it cancellable until Expo acknowledges.
      expect(uploadRegistry.size).toBe(1);
      expect(uploadRegistry.cancelAll()).toBe(1);
      expect(mockCancelAsync).toHaveBeenCalledTimes(2); // account sweep retries exact-task cancel

      finishNativeUpload({
        status: 200,
        body: JSON.stringify({ status: 200, data: { guid: 'late-server-message' } }),
      });
      await flushMicrotasks();
      expect(mockRemoveSubscription).toHaveBeenCalledTimes(1);
      expect(uploadRegistry.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('times out and removes an uploader queued behind both production gate slots', async () => {
    jest.useFakeTimers();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstBlocker = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondBlocker = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const first = uploadGate.run(() => firstBlocker);
    const second = uploadGate.run(() => secondBlocker);
    try {
      await flushMicrotasks();
      expect(uploadGate.active).toBe(2);

      const http = new HttpClient({
        getOrigin: () => 'https://old.example',
        getPassword: () => 'old-password',
      });
      const run = upload(http, { timeoutMs: 60_000 });
      finishFileCheck({ exists: true });
      await flushMicrotasks();
      expect(uploadGate.waiting).toBe(1);

      jest.advanceTimersByTime(60_000);
      await expect(run).rejects.toMatchObject({ kind: 'timeout' });
      await flushMicrotasks();
      expect(uploadGate.waiting).toBe(0);
      expect(uploadGate.active).toBe(2);
      expect(mockCreateUploadTask).not.toHaveBeenCalled();
      expect(mockUploadSettle).toHaveBeenCalledTimes(1);
      expect(uploadRegistry.size).toBe(0);
    } finally {
      releaseFirst();
      releaseSecond();
      await Promise.all([first, second]);
      jest.useRealTimers();
    }
    expect(uploadGate.active).toBe(0);
  });

  it('keeps a user/Disconnect cancellation that wins just before the timeout classified as cancelled', async () => {
    jest.useFakeTimers();
    let finishNativeUpload!: (value: MockUploadSuccess) => void;
    try {
      mockUploadAsync.mockImplementationOnce(
        () =>
          new Promise<MockUploadSuccess>((resolve) => {
            finishNativeUpload = resolve;
          }),
      );
      const http = new HttpClient({
        getOrigin: () => 'https://old.example',
        getPassword: () => 'old-password',
      });
      const run = upload(http, { timeoutMs: 60_000 });
      finishFileCheck({ exists: true });
      await flushMicrotasks();

      jest.advanceTimersByTime(59_999);
      expect(uploadRegistry.cancelAll()).toBe(1);
      jest.advanceTimersByTime(1);
      await expect(run).rejects.toMatchObject({ kind: 'cancelled' });
      expect(mockCancelAsync).toHaveBeenCalledTimes(1);

      finishNativeUpload({
        status: 200,
        body: JSON.stringify({ status: 200, data: { guid: 'late-server-message' } }),
      });
      await flushMicrotasks();
      expect(uploadRegistry.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears the deadline after success so no late cancellation fires', async () => {
    jest.useFakeTimers();
    try {
      const http = new HttpClient({
        getOrigin: () => 'https://old.example',
        getPassword: () => 'old-password',
      });
      const run = upload(http, { timeoutMs: 60_000 });
      finishFileCheck({ exists: true });
      await expect(run).resolves.toMatchObject({ guid: 'server-message' });

      jest.advanceTimersByTime(60_000);
      expect(mockCancelAsync).not.toHaveBeenCalled();
      expect(mockUploadSettle).toHaveBeenCalledTimes(1);
      expect(uploadRegistry.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
