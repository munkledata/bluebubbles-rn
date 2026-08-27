let mockFileExists = false;
let mockFileContents = '';
let mockFileText: (() => Promise<string>) | null = null;
let mockOnFileConstruct: (() => void) | null = null;
let mockFileSize: number | null = null;
let mockFileSizeThrows = false;
let mockFileReadAllowed = true;
let mockFileDeleteThrows = false;
let mockFileWriteThrows = false;
let mockFileWriteFailuresRemaining = 0;
const mockFileTextStarted = jest.fn();

jest.mock('expo-file-system', () => ({
  Paths: { document: '/documents' },
  File: class {
    constructor() {
      mockOnFileConstruct?.();
    }
    get exists(): boolean {
      return mockFileReadAllowed && mockFileExists;
    }
    get size(): number {
      if (mockFileSizeThrows) throw new Error('private size failure');
      return mockFileSize ?? mockFileContents.length;
    }
    delete(): void {
      if (mockFileDeleteThrows) throw new Error('private delete failure');
      if (!mockFileExists) throw new Error('file does not exist');
      mockFileExists = false;
      mockFileContents = '';
    }
    info(): { exists: boolean; size?: number } {
      if (!mockFileReadAllowed) throw new Error('private read permission failure');
      if (mockFileSizeThrows) throw new Error('private size failure');
      return mockFileExists
        ? { exists: true, size: mockFileSize ?? mockFileContents.length }
        : { exists: false };
    }
    create(): void {
      mockFileExists = true;
    }
    write(contents: string): void {
      if (mockFileWriteFailuresRemaining > 0) {
        mockFileWriteFailuresRemaining -= 1;
        throw new Error('private transient write failure');
      }
      if (mockFileWriteThrows) throw new Error('private write failure');
      mockFileExists = true;
      mockFileContents = contents;
    }
    async text(): Promise<string> {
      mockFileTextStarted();
      return mockFileText ? mockFileText() : mockFileContents;
    }
  },
}));

// eslint-disable-next-line import/first
import {
  FILE_LOG_OPERATION_TIMEOUT_MS,
  fileLogSink,
  FileLogSink,
  flushPersistentLogsForHeadlessCompletion,
  initPersistentLogs,
  MAX_PERSISTED_LOG_FILE_BYTES,
} from '@/services/logging/fileLogSink';
// eslint-disable-next-line import/first
import {
  ERROR_DIAGNOSTIC_SITES,
  logSinks,
  MAX_LOG_MESSAGE_CHARS,
  MAX_LOG_META_CHARS,
  RedactingLogger,
} from '@core/secure';

/**
 * FileLogSink's in-memory buffering plus its account-teardown ordering. Native file I/O is replaced
 * with one shared fake file; fake timers keep the ordinary debounced flush deterministic.
 */
describe('FileLogSink (buffering and teardown ordering)', () => {
  const validTimestamp = Date.UTC(2026, 7, 6, 12, 34);
  let previousDev: boolean | undefined;

  beforeEach(() => {
    previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    jest.useFakeTimers();
    mockFileExists = false;
    mockFileContents = '';
    mockFileText = null;
    mockOnFileConstruct = null;
    mockFileSize = null;
    mockFileSizeThrows = false;
    mockFileReadAllowed = true;
    mockFileDeleteThrows = false;
    mockFileWriteThrows = false;
    mockFileWriteFailuresRemaining = 0;
    mockFileTextStarted.mockClear();
  });
  afterEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('buffers written lines oldest-first via all()', () => {
    const sink = new FileLogSink();
    sink.write('info', 'a');
    sink.write('warn', 'b', { code: 1 });
    expect(sink.all().map((e) => e.message)).toEqual(['a', 'b']);
    expect(sink.all()[1]).toMatchObject({ level: 'warn', meta: '{"code":1}' });
  });

  it('caps the buffer at 500 (ring): oldest lines fall off', () => {
    const sink = new FileLogSink();
    for (let i = 0; i < 520; i++) sink.write('info', `line ${i}`);
    const all = sink.all();
    expect(all).toHaveLength(500);
    expect(all[0]!.message).toBe('line 20'); // first 20 dropped
    expect(all.at(-1)!.message).toBe('line 519'); // newest kept
  });

  it('bounds each retained line and metadata value', () => {
    const sink = new FileLogSink();
    sink.write(
      'warn',
      'm'.repeat(MAX_LOG_MESSAGE_CHARS + 100),
      'x'.repeat(MAX_LOG_META_CHARS + 100),
    );

    expect(sink.all()[0]?.message).toHaveLength(MAX_LOG_MESSAGE_CHARS);
    expect(sink.all()[0]?.meta).toHaveLength(MAX_LOG_META_CHARS);
  });

  it('confirms that clear removes both the buffer and persisted file', async () => {
    mockFileExists = true;
    mockFileContents = '[{"message":"old account"}]';
    const sink = new FileLogSink();
    sink.write('info', 'old account');

    await expect(sink.clear()).resolves.toBe(true);

    expect(sink.all()).toEqual([]);
    expect(mockFileExists).toBe(false);
    expect(sink.hasConfirmedCleanup()).toBe(true);
  });

  it('rebuilds a legacy error into the strict envelope before restoring or rewriting it', async () => {
    mockFileExists = true;
    mockFileContents = JSON.stringify([
      {
        level: 'error',
        message:
          '[socket] error connecting to old.private.example for alice@example.com id 550e8400-e29b-41d4-a716-446655440000',
        meta: JSON.stringify({
          name: 'ApiError',
          kind: 'no_connection',
          status: 503,
          response: 'phone 3035550199',
        }),
        timestamp: validTimestamp + 59_999,
      },
      {
        level: 'warn',
        message: 'private legacy warning for alice@example.com',
        meta: JSON.stringify({ response: 'private response 3035550199' }),
        timestamp: validTimestamp + 60_000,
      },
      {
        level: 'info',
        message: 'content://provider/private-name',
        timestamp: validTimestamp + 120_000,
      },
      {
        level: 'info',
        message: 'fcm.push_received [untrusted legacy qualifiers]',
        meta: JSON.stringify({
          eventName: 'updated-message',
          source: 'background',
          body: 'private event body',
        }),
        timestamp: validTimestamp + 180_000,
      },
    ]);
    const sink = new FileLogSink();

    await sink.init();

    const [entry, receipt] = sink.all();
    expect(entry?.message).toBe('socket.connection_failed [ApiError|no_connection|http_5xx]');
    expect(entry?.meta).toBe(
      JSON.stringify({
        schemaVersion: 1,
        errorName: 'ApiError',
        errorCode: 'no_connection',
        status: 503,
      }),
    );
    expect(entry?.timestamp).toBe(validTimestamp);
    expect(mockFileContents).not.toContain('old.private.example');
    expect(mockFileContents).not.toContain('alice@example.com');
    expect(mockFileContents).not.toContain('3035550199');
    expect(mockFileContents).not.toContain('content://');
    expect(mockFileContents).not.toContain('private event body');
    expect(receipt).toEqual({
      level: 'info',
      message: 'fcm.push_received [event:updated-message|source:background]',
      meta: JSON.stringify({
        schemaVersion: 1,
        eventName: 'updated-message',
        source: 'background',
      }),
      timestamp: validTimestamp + 180_000,
    });
    expect(sink.all()).toHaveLength(2);
    expect(mockFileContents).toContain('socket.connection_failed');
    expect(mockFileContents).toContain('fcm.push_received');
  });

  it.each([3035550199, 1e300, 1.5, Date.UTC(2200, 0, 1)])(
    'purges a legacy ERROR carrying unsafe timestamp %s',
    async (timestamp) => {
      mockFileExists = true;
      mockFileContents = JSON.stringify([
        {
          level: 'error',
          message: '[media] share failed',
          meta: 'private timestamp canary',
          timestamp,
        },
      ]);
      const sink = new FileLogSink();

      await expect(sink.init()).resolves.toEqual([]);

      expect(sink.all()).toEqual([]);
      expect(mockFileContents).toBe('[]');
      expect(mockFileContents).not.toContain(String(timestamp));
    },
  );

  it('drops direct free-form writes in release while retaining finite diagnostics', () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    const sink = new FileLogSink();

    sink.write('debug', 'private debug');
    sink.write('info', 'private info');
    sink.write('warn', 'private warning');
    sink.write('info', 'fcm.push_received', {
      eventName: 'new-message',
      source: 'background',
      body: 'private event body',
    });
    sink.write('error', '[media] share failed', new TypeError('private error'));

    expect(sink.all()).toEqual([
      {
        level: 'info',
        message: 'fcm.push_received [event:new-message|source:background]',
        meta: JSON.stringify({
          schemaVersion: 1,
          eventName: 'new-message',
          source: 'background',
        }),
        timestamp: expect.any(Number),
      },
      {
        level: 'error',
        message: 'media.share_failed [TypeError]',
        meta: JSON.stringify({
          schemaVersion: 1,
          errorName: 'TypeError',
        }),
        timestamp: expect.any(Number),
      },
    ]);
    expect(JSON.stringify(sink.all())).not.toContain('private event body');
  });

  it('drops a release non-error before serializing hostile metadata', () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    const sink = new FileLogSink();
    let inspected = false;
    const hostile = {
      toJSON: () => {
        inspected = true;
        throw new Error('private');
      },
    };

    sink.write('warn', 'private', hostile);

    expect(inspected).toBe(false);
    expect(sink.all()).toEqual([]);
  });

  it('never retains free-form error prose even when a caller reaches the file sink directly', () => {
    const sink = new FileLogSink();
    const logger = new RedactingLogger(sink);
    logger.error('[media] share failed', ERROR_DIAGNOSTIC_SITES.mediaShare, {
      name: 'TypeError',
      message: 'private response for alice@example.com and +13035550199',
      stack: 'TypeError: private\n at AlicePassport.ts:3035550:199',
    });

    const [entry] = sink.all();
    expect(entry).toEqual({
      level: 'error',
      message: 'media.share_failed [TypeError]',
      meta: JSON.stringify({
        schemaVersion: 1,
        errorName: 'TypeError',
        stack: `at gator.site.${ERROR_DIAGNOSTIC_SITES.mediaShare}`,
      }),
      timestamp: expect.any(Number),
    });
    expect(JSON.stringify(entry)).not.toMatch(
      /alice@example\.com|\+13035550199|AlicePassport|3035550199|private response/,
    );
  });

  it('deletes a corrupt plaintext log instead of leaving private fragments at rest', async () => {
    mockFileExists = true;
    mockFileContents = 'partial write for alice@example.com';
    const sink = new FileLogSink();

    await expect(sink.init()).resolves.toEqual([]);

    expect(sink.all()).toEqual([]);
    expect(mockFileExists).toBe(false);
    expect(mockFileContents).toBe('');
  });

  it('deletes an oversized persisted log without reading it into JavaScript', async () => {
    mockFileExists = true;
    mockFileSize = MAX_PERSISTED_LOG_FILE_BYTES + 1;
    mockFileContents = 'private legacy diagnostics';
    const sink = new FileLogSink();

    await expect(sink.init()).resolves.toEqual([]);

    expect(mockFileTextStarted).not.toHaveBeenCalled();
    expect(mockFileExists).toBe(false);
    expect(mockFileContents).toBe('');
  });

  it.each(['size', 'read'] as const)(
    'deletes legacy plaintext when the native %s operation fails',
    async (failure) => {
      mockFileExists = true;
      mockFileContents = 'private legacy diagnostics for alice@example.com';
      if (failure === 'size') mockFileSizeThrows = true;
      else mockFileText = async () => Promise.reject(new Error('private read failure'));
      const sink = new FileLogSink();

      await expect(sink.init()).resolves.toEqual([]);

      expect(mockFileExists).toBe(false);
      expect(mockFileContents).toBe('');
    },
  );

  it('rejects initialization when legacy plaintext can neither be rewritten nor deleted', async () => {
    mockFileExists = true;
    mockFileContents = JSON.stringify([
      {
        level: 'error',
        message: '[media] share failed',
        timestamp: validTimestamp,
      },
    ]);
    mockFileDeleteThrows = true;
    mockFileWriteThrows = true;
    const sink = new FileLogSink();

    await expect(sink.init()).rejects.toThrow('persistent-log-cleanup-failed');
    expect(mockFileExists).toBe(true);
  });

  it('fails closed when the native file handle cannot be created', async () => {
    mockFileExists = true;
    mockFileContents = 'private legacy diagnostics for alice@example.com';
    mockOnFileConstruct = () => {
      throw new Error('native file constructor unavailable');
    };
    const sink = new FileLogSink();

    await expect(sink.init()).rejects.toThrow('persistent-log-cleanup-failed');

    // With no handle, the app cannot prove the old bytes absent. Startup must surface that fact.
    expect(mockFileExists).toBe(true);
    expect(mockFileContents).toContain('alice@example.com');
  });

  it('reports an unconfirmed manual clear instead of pretending the file is gone', async () => {
    mockFileExists = true;
    mockFileContents = 'private legacy diagnostics';
    mockFileDeleteThrows = true;
    const sink = new FileLogSink();

    await expect(sink.clear()).resolves.toBe(false);
    expect(mockFileExists).toBe(true);
    expect(sink.hasConfirmedCleanup()).toBe(false);
  });

  it('does not mistake an unreadable existing file for confirmed absence', async () => {
    mockFileExists = true;
    mockFileContents = 'private legacy diagnostics';
    mockFileReadAllowed = false;
    mockFileDeleteThrows = true;
    const sink = new FileLogSink();

    await expect(sink.init()).rejects.toThrow('persistent-log-cleanup-failed');
    await expect(sink.clear()).resolves.toBe(false);
    expect(mockFileExists).toBe(true);
  });

  it('accepts a successful delete even when the old file could not be read', async () => {
    mockFileExists = true;
    mockFileContents = 'private legacy diagnostics';
    mockFileReadAllowed = false;
    const sink = new FileLogSink();

    await expect(sink.init()).resolves.toEqual([]);
    expect(mockFileExists).toBe(false);
    expect(mockFileContents).toBe('');
  });

  it('times out a hung read so a later Clear can still remove the file', async () => {
    mockFileExists = true;
    mockFileContents = 'private legacy diagnostics';
    const readStarted = Promise.withResolvers<void>();
    mockFileText = () => {
      readStarted.resolve();
      return new Promise<string>(() => {});
    };
    const sink = new FileLogSink();

    const initializing = sink.init();
    const initializationFailure = expect(initializing).rejects.toThrow(
      'persistent-log-operation-timed-out',
    );
    await readStarted.promise;
    const clearing = sink.clear();
    await jest.advanceTimersByTimeAsync(FILE_LOG_OPERATION_TIMEOUT_MS);

    await initializationFailure;
    await expect(clearing).resolves.toBe(true);
    expect(mockFileExists).toBe(false);
    expect(sink.all()).toEqual([]);
  });

  it('retries a failed flush and persists once native writes recover', async () => {
    const sink = new FileLogSink();
    sink.write('error', '[media] share failed');
    mockFileWriteThrows = true;

    await expect(sink.flush()).resolves.toBe(false);
    expect(mockFileExists).toBe(false);

    mockFileWriteThrows = false;
    await jest.advanceTimersByTimeAsync(1500);

    expect(mockFileExists).toBe(true);
    expect(mockFileContents).toContain('media.share_failed');
  });

  it('makes a concurrent explicit flush wait for the disk write already in flight', async () => {
    mockFileExists = true;
    const readStarted = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<string>();
    mockFileText = () => {
      readStarted.resolve();
      return releaseRead.promise;
    };
    const sink = new FileLogSink();

    const initializing = sink.init();
    await readStarted.promise;
    sink.write('error', '[media] share failed');
    const firstFlush = sink.flush();
    const joiningFlush = sink.flush();
    let joiningFlushSettled = false;
    void joiningFlush.then(() => {
      joiningFlushSettled = true;
    });

    await Promise.resolve();
    expect(joiningFlushSettled).toBe(false);

    releaseRead.resolve('[]');
    await initializing;
    await expect(firstFlush).resolves.toBe(true);
    await expect(joiningFlush).resolves.toBe(true);
    expect(mockFileContents).toContain('media.share_failed');
  });

  it('makes a joining flush retry after the in-flight write fails', async () => {
    mockFileExists = true;
    const readStarted = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<string>();
    mockFileText = () => {
      readStarted.resolve();
      return releaseRead.promise;
    };
    const sink = new FileLogSink();

    const initializing = sink.init();
    await readStarted.promise;
    sink.write('error', '[media] share failed');
    const firstFlush = sink.flush();
    const joiningFlush = sink.flush();
    // The restore rewrite and first flush both fail. Each confirms deletion, and the joining flush
    // must observe the restored dirty flag and perform the successful third write itself.
    mockFileWriteFailuresRemaining = 2;
    releaseRead.resolve('[]');

    await expect(initializing).resolves.toEqual([]);
    await expect(firstFlush).resolves.toBe(false);
    await expect(joiningFlush).resolves.toBe(true);
    expect(mockFileContents).toContain('media.share_failed');
  });

  it('retries a headless completion flush immediately without leaking a rejection', async () => {
    const flush = jest
      .spyOn(fileLogSink, 'flush')
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('native write failed'))
      .mockResolvedValueOnce(true);

    await expect(flushPersistentLogsForHeadlessCompletion()).resolves.toBe(true);

    expect(flush).toHaveBeenCalledTimes(3);
    flush.mockRestore();
  });

  it('returns false after all three headless flush attempts fail', async () => {
    const flush = jest.spyOn(fileLogSink, 'flush').mockResolvedValue(false);

    await expect(flushPersistentLogsForHeadlessCompletion()).resolves.toBe(false);

    expect(flush).toHaveBeenCalledTimes(3);
    flush.mockRestore();
  });

  it('preserves writes made during init and flushes the merged history', async () => {
    mockFileExists = true;
    const readStarted = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<string>();
    mockFileText = () => {
      readStarted.resolve();
      return releaseRead.promise;
    };
    const sink = new FileLogSink();

    const initializing = sink.init();
    await readStarted.promise;
    sink.write('warn', 'new-session-line');
    const flushing = sink.flush();
    releaseRead.resolve(
      JSON.stringify([{ level: 'info', message: 'persisted-line', timestamp: 1 }]),
    );

    await Promise.all([initializing, flushing]);
    expect(sink.all().map((entry) => entry.message)).toEqual(['new-session-line']);
    expect(
      (JSON.parse(mockFileContents) as Array<{ message: string }>).map((entry) => entry.message),
    ).toEqual(['new-session-line']);
  });

  it('blocks late hydration and clears writes that land while teardown waits on init', async () => {
    mockFileExists = true;
    const readStarted = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<string>();
    mockFileText = () => {
      readStarted.resolve();
      return releaseRead.promise;
    };
    const sink = new FileLogSink();
    const hydrate = jest.fn<void, [unknown]>();

    const restore = sink.restore(hydrate);
    await readStarted.promise;
    const clear = sink.clear();
    sink.write('warn', 'retiring-account-line-during-clear');
    // init already constructed its File. The next construction belongs to clear(), after its
    // serialized reset but before deletion, and simulates one final old callback at that boundary.
    mockOnFileConstruct = () => sink.write('warn', 'retiring-account-line-during-native-clear');

    releaseRead.resolve(
      JSON.stringify([{ level: 'info', message: 'old account', timestamp: Date.now() }]),
    );
    await expect(restore).resolves.toBeUndefined();
    await expect(clear).resolves.toBe(true);

    expect(hydrate).not.toHaveBeenCalled();
    expect(sink.all()).toEqual([]);
    expect(mockFileExists).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('attaches the process singleton before persistent initialization yields', async () => {
    const add = jest.spyOn(logSinks, 'add');

    const initialization = initPersistentLogs();

    expect(add).toHaveBeenCalledWith(fileLogSink);
    await expect(initialization).resolves.toBeUndefined();
    add.mockRestore();
  });
});
