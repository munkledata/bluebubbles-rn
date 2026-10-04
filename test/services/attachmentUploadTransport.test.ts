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
import { ApiError } from '@core/api/errors';
// eslint-disable-next-line import/first
import {
  MAX_IMESSAGE_ATTACHMENT_UPLOAD_BYTES,
  MAX_SEND_ATTACHMENT_TEXT_BYTES,
} from '@core/models/serverInfo';
// eslint-disable-next-line import/first
import { HttpClient } from '@core/api/http';
// eslint-disable-next-line import/first
import { logger } from '@core/secure';
// eslint-disable-next-line import/first
import { DbCommitGuardRejectedError } from '@db/transaction';
// eslint-disable-next-line import/first
import { expoAttachmentUploader } from '@/services/send/attachmentUpload';
// eslint-disable-next-line import/first
import { uploadGate, uploadRegistry } from '@/services/send/uploadControl';

let finishFileCheck!: (value: { exists: boolean; size?: number }) => void;

beforeEach(async () => {
  uploadRegistry.cancelAll();
  await uploadRegistry.awaitIdle();
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

afterEach(async () => {
  uploadRegistry.cancelAll();
  await uploadRegistry.awaitIdle();
  jest.restoreAllMocks();
});

function upload(
  http: HttpClient,
  options: {
    chatGuid?: string;
    tempGuid?: string;
    timeoutMs?: number;
    clientAttemptGeneration?: number;
    service?: 'iMessage' | 'RCS';
    voice?: true;
    text?: string;
    totalBytes?: number;
    name?: string;
    uri?: string;
    mimeType?: string;
    assertNetworkStart?: () => void;
    signal?: AbortSignal;
  } = {},
): ReturnType<typeof expoAttachmentUploader> {
  return expoAttachmentUploader({
    http,
    chatGuid: options.chatGuid ?? 'RCS;-;chat-1',
    tempGuid: options.tempGuid ?? 'temp-1',
    clientAttemptGeneration: options.clientAttemptGeneration,
    service: options.service,
    voice: options.voice,
    text: options.text,
    assertNetworkStart: options.assertNetworkStart,
    attachmentGuid: `att-${options.tempGuid ?? '1'}`,
    name: options.name ?? 'photo.jpg',
    uri: options.uri ?? 'file:///photo.jpg',
    mimeType: options.mimeType ?? 'image/jpeg',
    totalBytes: options.totalBytes ?? 42,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

async function flushMicrotasks(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

describe('native attachment upload account scope', () => {
  it.each(['../report.pdf', 'report".pdf', '\ud800.pdf', 'a'.repeat(256) + '.pdf'])(
    'rejects unsafe names before reading a file or starting a native task',
    async (name) => {
      const http = new HttpClient({
        getOrigin: () => 'https://test.example',
        getPassword: () => 'test-password',
      });
      await expect(upload(http, { name })).rejects.toMatchObject({
        name: 'ApiError',
        kind: 'local_file',
        message: 'Attachment filename is invalid; choose another file or rename it.',
      });
      expect(mockGetInfoAsync).not.toHaveBeenCalled();
      expect(mockCreateUploadTask).not.toHaveBeenCalled();
      expect(uploadRegistry.cancelAll()).toBe(0);
    },
  );

  it('keeps same-name concurrent uploads tied to their separate source files', async () => {
    mockGetInfoAsync.mockResolvedValue({ exists: true, size: 42 });
    const http = new HttpClient({
      getOrigin: () => 'https://test.example',
      getPassword: () => 'test-password',
    });
    await Promise.all(
      ['first', 'second'].map((id) =>
        upload(http, {
          tempGuid: id,
          name: 'résumé%22.pdf',
          mimeType: 'application/pdf',
          uri: `file:///cache/${id}.pdf`,
        }),
      ),
    );
    expect(
      mockCreateUploadTask.mock.calls.map((call) => ({
        uri: call[1],
        name: call[2].gatorFileName,
        tempGuid: call[2].parameters.tempGuid,
      })),
    ).toEqual([
      { uri: 'file:///cache/first.pdf', name: 'résumé%22.pdf', tempGuid: 'first' },
      { uri: 'file:///cache/second.pdf', name: 'résumé%22.pdf', tempGuid: 'second' },
    ]);
    expect(mockRemoveSubscription).toHaveBeenCalledTimes(2);
    expect(uploadRegistry.cancelAll()).toBe(0);
  });

  it('marks only an explicit M4A iMessage voice upload', async () => {
    mockUploadAsync.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ status: 200, data: { guid: 'voice-guid', viaPrivateApi: true } }),
    });
    const http = new HttpClient({
      getOrigin: () => 'https://old.example',
      getPassword: () => 'old-password',
    });
    const run = upload(http, {
      chatGuid: 'any;-;+15551234567',
      service: 'iMessage',
      voice: true,
      assertNetworkStart: () => undefined,
      totalBytes: 2048,
      name: 'voice.m4a',
      uri: 'file:///cache/voice.m4a',
      mimeType: 'audio/mp4',
    });
    finishFileCheck({ exists: true, size: 2048 });
    await expect(run).resolves.toMatchObject({ guid: 'voice-guid' });
    expect(mockCreateUploadTask.mock.calls[0]?.[2]?.parameters).toMatchObject({
      uploadKind: 'imessage_voice',
      chatGuid: 'any;-;+15551234567',
    });
  });

  it('preserves the original multipart filename for an iMessage Files-picker cache copy', async () => {
    mockUploadAsync.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({
        status: 200,
        data: { guid: 'image-message-guid', viaPrivateApi: true },
      }),
    });
    const http = new HttpClient({
      getOrigin: () => 'https://old.example',
      getPassword: () => 'old-password',
    });
    const assertNetworkStart = jest.fn();
    const run = upload(http, {
      chatGuid: 'any;-;+15551234567',
      service: 'iMessage',
      assertNetworkStart,
      totalBytes: 42,
      name: 'original-photo.jpg',
      uri: 'file:///cache/DocumentPicker/uuid-copy.jpg',
    });
    finishFileCheck({ exists: true, size: 42 });
    await expect(run).resolves.toMatchObject({ guid: 'image-message-guid' });
    expect(assertNetworkStart).toHaveBeenCalledTimes(1);
    const [, nativeUri, options] = mockCreateUploadTask.mock.calls[0]!;
    expect(nativeUri).toBe('file:///cache/DocumentPicker/uuid-copy.jpg');
    expect(options.gatorFileName).toBe('original-photo.jpg');
    expect(options.parameters).toMatchObject({
      chatGuid: 'any;-;+15551234567',
      tempGuid: 'temp-1',
    });
    expect(options.parameters).not.toHaveProperty('name');
    expect(options.parameters).not.toHaveProperty('text');
    expect(options.parameters).not.toHaveProperty('clientAttemptGeneration');
    expect(options.parameters).not.toHaveProperty('service');
  });

  it('streams a PDF with its exact MIME and omits the conflicting original-name field', async () => {
    mockUploadAsync.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({
        status: 200,
        data: { guid: 'pdf-message-guid', viaPrivateApi: true },
      }),
    });
    const http = new HttpClient({
      getOrigin: () => 'https://old.example',
      getPassword: () => 'old-password',
    });
    const run = upload(http, {
      chatGuid: 'any;-;+15551234567',
      service: 'iMessage',
      assertNetworkStart: () => undefined,
      name: 'original-report.pdf',
      uri: 'file:///cache/DocumentPicker/uuid-copy.pdf',
      mimeType: 'application/pdf',
      totalBytes: 2048,
    });
    finishFileCheck({ exists: true, size: 2048 });
    await expect(run).resolves.toMatchObject({ guid: 'pdf-message-guid' });
    const [, , options] = mockCreateUploadTask.mock.calls[0]!;
    expect(options.mimeType).toBe('application/pdf');
    expect(options.gatorFileName).toBe('original-report.pdf');
    expect(options.parameters).not.toHaveProperty('name');
  });

  it.each([
    ['JPEG', 'image/jpeg', 'original-photo.jpg', 'uuid-copy.jpg'],
    ['PDF', 'application/pdf', 'original-report.pdf', 'uuid-copy.pdf'],
  ])(
    'streams one %s with exact caption text in the same multipart request',
    async (_kind, mimeType, name, cacheName) => {
      mockUploadAsync.mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          status: 200,
          data: { guid: 'captioned-message-guid', viaPrivateApi: true },
        }),
      });
      const http = new HttpClient({
        getOrigin: () => 'https://old.example',
        getPassword: () => 'old-password',
      });
      const caption = '  Look at this 📄  ';
      const run = upload(http, {
        chatGuid: 'any;-;+15551234567',
        service: 'iMessage',
        assertNetworkStart: () => undefined,
        name,
        uri: `file:///cache/DocumentPicker/${cacheName}`,
        mimeType,
        totalBytes: 2048,
        text: caption,
      });
      finishFileCheck({ exists: true, size: 2048 });
      await expect(run).resolves.toMatchObject({ guid: 'captioned-message-guid' });
      expect(mockCreateUploadTask).toHaveBeenCalledTimes(1);
      const [, , options] = mockCreateUploadTask.mock.calls[0]!;
      expect(options.parameters.text).toBe(caption);
      expect(options.gatorFileName).toBe(name);
      expect(options.parameters).not.toHaveProperty('name');
      expect(options.parameters).not.toHaveProperty('clientAttemptGeneration');
    },
  );

  it.each(['  ', '📄'.repeat(MAX_SEND_ATTACHMENT_TEXT_BYTES / 4 + 1)])(
    'rejects a blank or oversized direct iMessage caption before native file work',
    async (text) => {
      const http = new HttpClient({
        getOrigin: () => 'https://old.example',
        getPassword: () => 'old-password',
      });
      await expect(
        upload(http, {
          chatGuid: 'any;-;+15551234567',
          service: 'iMessage',
          assertNetworkStart: () => undefined,
          text,
        }),
      ).rejects.toThrow('iMessage attachment caption is blank or exceeds the 65,536-byte limit.');
      expect(mockGetInfoAsync).not.toHaveBeenCalled();
      expect(mockCreateUploadTask).not.toHaveBeenCalled();
    },
  );

  it('rejects an oversized actual iMessage file before starting native upload', async () => {
    const http = new HttpClient({
      getOrigin: () => 'https://old.example',
      getPassword: () => 'old-password',
    });
    const run = upload(http, {
      chatGuid: 'any;-;+15551234567',
      service: 'iMessage',
      assertNetworkStart: () => undefined,
      totalBytes: 0,
    });
    finishFileCheck({ exists: true, size: MAX_IMESSAGE_ATTACHMENT_UPLOAD_BYTES + 1 });
    await expect(run).rejects.toMatchObject({ kind: 'local_file' });
    expect(mockCreateUploadTask).not.toHaveBeenCalled();
  });

  it.each([1024 * 1024 - 1, 1024 * 1024, 1024 * 1024 + 1])(
    'rejects a direct iMessage %i-byte upload before native file or network work',
    async (totalBytes) => {
      const http = new HttpClient({
        getOrigin: () => 'https://old.example',
        getPassword: () => 'old-password',
      });

      await expect(upload(http, { chatGuid: 'iMessage;-;chat-1', totalBytes })).rejects.toThrow(
        'iMessage attachments require the narrow attachment-only capability',
      );
      expect(mockGetInfoAsync).not.toHaveBeenCalled();
      expect(mockCreateUploadTask).not.toHaveBeenCalled();
      expect(uploadRegistry.size).toBe(0);
    },
  );

  it.each([1024 * 1024 - 1, 1024 * 1024, 1024 * 1024 + 1])(
    'uses the multipart route for a supported RCS %i-byte upload',
    async (totalBytes) => {
      const http = new HttpClient({
        getOrigin: () => 'https://old.example',
        getPassword: () => 'old-password',
      });

      const run = upload(http, { totalBytes });
      finishFileCheck({ exists: true });
      await expect(run).resolves.toMatchObject({ guid: 'server-message' });

      expect(mockCreateUploadTask).toHaveBeenCalledTimes(1);
      const [url, , options] = mockCreateUploadTask.mock.calls[0]!;
      expect(url).toBe('https://old.example/api/v1/message/attachment/upload');
      expect(options).toMatchObject({
        httpMethod: 'POST',
        uploadType: 1,
        fieldName: 'attachment',
      });
    },
  );

  it.each([301, 302, 303, 307, 308])(
    'rejects redirect status %i instead of accepting a native follow-up result',
    async (status) => {
      mockUploadAsync.mockResolvedValueOnce({ status, body: '' });
      const http = new HttpClient({
        getOrigin: () => 'https://old.example',
        getPassword: () => 'old-password',
      });

      const run = upload(http);
      finishFileCheck({ exists: true });

      await expect(run).rejects.toMatchObject({ kind: 'server_error', status });
      expect(mockCreateUploadTask).toHaveBeenCalledTimes(1);
      expect(mockRemoveSubscription).toHaveBeenCalledTimes(1);
    },
  );

  it('projects a bounded server rejection detail without logging the raw body', async () => {
    const privateDetail = 'Recipient person@example.com could not be reached.';
    mockUploadAsync.mockResolvedValueOnce({
      status: 422,
      body: JSON.stringify({ error: { type: 'send_failed', message: privateDetail } }),
    });
    const http = new HttpClient({
      getOrigin: () => 'https://old.example',
      getPassword: () => 'old-password',
    });

    const run = upload(http);
    finishFileCheck({ exists: true });
    let caught: unknown;
    try {
      await run;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({
      kind: 'bad_request',
      status: 422,
    });
    expect((caught as ApiError).serverDetail).toBe('Recipient [redacted] could not be reached.');
    expect((caught as ApiError).serverErrorType).toBe('send_failed');
    expect(logger.warn).toHaveBeenCalledWith(
      '[upload] server rejected status=422 type=send_failed',
    );
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain(privateDetail);
  });

  it('rejects an oversized native error body without scanning or retaining its prose', async () => {
    const canary = 'native-body-canary';
    mockUploadAsync.mockResolvedValueOnce({
      status: 502,
      body: JSON.stringify({ error: { message: `${canary}${'x'.repeat(5_000)}` } }),
    });
    const http = new HttpClient({
      getOrigin: () => 'https://old.example',
      getPassword: () => 'old-password',
    });

    const run = upload(http);
    finishFileCheck({ exists: true });
    let caught: unknown;
    try {
      await run;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({ kind: 'server_error', status: 502 });
    expect((caught as ApiError).serverDetail).toBeUndefined();
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain(canary);
  });

  it('keeps the original URL and credential when the live account changes during preflight', async () => {
    let origin = 'https://old.example';
    let password = 'old-password';
    const http = new HttpClient({
      getOrigin: () => origin,
      getPassword: () => password,
    });

    const run = upload(http, {
      clientAttemptGeneration: 7,
      text: 'caption',
    });
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
    expect(options.parameters.clientAttemptGeneration).toBe('7');
    expect(options.parameters.text).toBe('caption');
    expect(options.parameters).not.toHaveProperty('method');
    expect(options.parameters).not.toHaveProperty('selectedMessageGuid');
    expect(options.parameters).not.toHaveProperty('partIndex');
    expect(uploadRegistry.size).toBe(0);
  });

  it('does not start a pinned native task after the transport rotates during file preflight', async () => {
    let origin = 'https://old.example';
    let transportRevision = 1;
    const http = new HttpClient({
      getOrigin: () => origin,
      getPassword: () => 'password',
      getTransportRevision: () => transportRevision,
    });

    const run = upload(http.pinTransport());
    expect(mockGetInfoAsync).toHaveBeenCalledWith('file:///photo.jpg');

    origin = 'https://new.example';
    transportRevision += 1;
    finishFileCheck({ exists: true });

    await expect(run).rejects.toMatchObject({ kind: 'cancelled' });
    expect(mockCreateUploadTask).not.toHaveBeenCalled();
    expect(uploadRegistry.size).toBe(0);
  });

  it('rechecks send capability after file preflight and before starting the native task', async () => {
    let capabilityCurrent = true;
    const assertNetworkStart = jest.fn(() => {
      if (!capabilityCurrent) throw new DbCommitGuardRejectedError();
    });
    const http = new HttpClient({
      getOrigin: () => 'https://old.example',
      getPassword: () => 'old-password',
    });

    const run = upload(http, { assertNetworkStart });
    capabilityCurrent = false;
    finishFileCheck({ exists: true });

    await expect(run).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    expect(assertNetworkStart).toHaveBeenCalledTimes(1);
    expect(mockCreateUploadTask).not.toHaveBeenCalled();
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
      expect(uploadRegistry.pending).toBe(1);
      const nativeIdle = uploadRegistry.awaitIdle();
      let nativeIdleSettled = false;
      void nativeIdle.then(() => {
        nativeIdleSettled = true;
      });
      await flushMicrotasks();
      expect(nativeIdleSettled).toBe(false);

      finishNativeUpload({
        status: 200,
        body: JSON.stringify({ status: 200, data: { guid: 'late-server-message' } }),
      });
      await flushMicrotasks();
      await expect(nativeIdle).resolves.toBeUndefined();
      expect(mockRemoveSubscription).toHaveBeenCalledTimes(1);
      expect(uploadRegistry.size).toBe(0);
      expect(uploadRegistry.pending).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels one active native task when its callback owner expires', async () => {
    let finishNativeUpload!: (value: MockUploadSuccess) => void;
    mockUploadAsync.mockImplementationOnce(
      () =>
        new Promise<MockUploadSuccess>((resolve) => {
          finishNativeUpload = resolve;
        }),
    );
    const owner = new AbortController();
    const http = new HttpClient({
      getOrigin: () => 'https://old.example',
      getPassword: () => 'old-password',
    });
    const run = upload(http, { signal: owner.signal });
    finishFileCheck({ exists: true });
    await flushMicrotasks();
    expect(mockCreateUploadTask).toHaveBeenCalledTimes(1);

    owner.abort(new Error('background callback expired'));
    await expect(run).rejects.toMatchObject({ kind: 'cancelled' });
    expect(mockCancelAsync).toHaveBeenCalledTimes(1);
    expect(mockUploadSettle).toHaveBeenCalledTimes(1);
    expect(uploadRegistry.size).toBe(1);

    finishNativeUpload({
      status: 200,
      body: JSON.stringify({ status: 200, data: { guid: 'late-server-message' } }),
    });
    await flushMicrotasks();
    await expect(uploadRegistry.awaitIdle()).resolves.toBeUndefined();
    expect(mockRemoveSubscription).toHaveBeenCalledTimes(1);
    expect(uploadRegistry.size).toBe(0);
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
