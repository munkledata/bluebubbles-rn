import {
  ConsoleSink,
  isVerboseLocalLoggingEnabled,
  RedactingLogger,
  type LogSink,
} from '@core/secure';

describe('app logger (RedactingLogger + ConsoleSink)', () => {
  let previousDev: boolean | undefined;

  beforeEach(() => {
    previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
  });

  afterEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
  });

  it('enables free-form local logs only for an explicit development runtime', () => {
    delete (globalThis as { __DEV__?: boolean }).__DEV__;
    expect(isVerboseLocalLoggingEnabled()).toBe(false);
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    expect(isVerboseLocalLoggingEnabled()).toBe(false);
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    expect(isVerboseLocalLoggingEnabled()).toBe(true);
  });

  it('scrubs sensitive meta keys and ?guid= URL params before the sink sees them', () => {
    const writes: Array<{ message: string; meta: unknown }> = [];
    const sink: LogSink = { write: (_l, message, meta) => writes.push({ message, meta }) };
    const log = new RedactingLogger(sink);

    log.info('GET https://x.ngrok.io/api/v1/chat?guid=SUPERSECRET&limit=20', {
      password: 'pw',
      token: 'tk',
      authorization: 'Bearer z',
      keep: 1,
    });

    const [w] = writes;
    expect(w!.message).toContain('guid=[redacted]');
    expect(w!.message).not.toContain('SUPERSECRET');
    expect(w!.meta).toEqual({
      password: '[redacted]',
      token: '[redacted]',
      authorization: '[redacted]',
      keep: 1,
    });
  });

  it('projects error prose before any TeeSink child can retain it', () => {
    const writes: Array<{ level: string; message: string; meta: unknown }> = [];
    const sink: LogSink = {
      write: (level, message, meta) => writes.push({ level, message, meta }),
    };
    const log = new RedactingLogger(sink);

    log.error('[socket] connection failed', {
      name: 'ApiError',
      kind: 'timeout',
      status: 504,
      message: 'private response for alice@example.com and +13035550199',
      stack: 'ApiError: private\n at AlicePassport.ts:3035550:199',
    });

    expect(writes).toEqual([
      {
        level: 'error',
        message: 'socket.connection_failed [ApiError|timeout|http_5xx]',
        meta: {
          schemaVersion: 1,
          errorName: 'ApiError',
          errorCode: 'timeout',
          status: 504,
          stack: 'at gator.socket.connection_failed',
        },
      },
    ]);
    expect(JSON.stringify(writes)).not.toMatch(
      /alice@example\.com|\+13035550199|AlicePassport|3035550199|private response/,
    );
  });

  it('projects a finite FCM receipt before the release sink boundary', () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    const writes: unknown[] = [];
    const log = new RedactingLogger({ write: (...args) => void writes.push(args) });

    log.event('fcm.push_received', {
      eventName: 'new-message',
      source: 'background',
    });

    expect(writes).toEqual([
      [
        'info',
        'fcm.push_received [event:new-message|source:background]',
        { schemaVersion: 1, eventName: 'new-message', source: 'background' },
      ],
    ]);
  });

  it('ConsoleSink suppresses every free-form level in production but emits them in dev', () => {
    const sink = new ConsoleSink();
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const prev = (globalThis as { __DEV__?: boolean }).__DEV__;
    try {
      (globalThis as { __DEV__?: boolean }).__DEV__ = false;
      sink.write('debug', 'prod-noise');
      sink.write('info', 'prod-info');
      sink.write('info', 'fcm.push_received', {
        eventName: 'new-message',
        source: 'background',
      });
      sink.write('warn', 'prod-warning');
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();

      (globalThis as { __DEV__?: boolean }).__DEV__ = true;
      sink.write('debug', 'dev-line');
      sink.write('info', 'dev-info');
      sink.write('warn', 'dev-warning');
      expect(log).toHaveBeenCalledWith('dev-line');
      expect(log).toHaveBeenCalledWith('dev-info');
      expect(warn).toHaveBeenCalledWith('dev-warning');
    } finally {
      (globalThis as { __DEV__?: boolean }).__DEV__ = prev;
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it('ConsoleSink drops a release non-error before inspecting hostile metadata', () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    const sink = new ConsoleSink();
    let inspected = false;
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          inspected = true;
          throw new Error('private');
        },
      },
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => sink.write('warn', 'private', hostile)).not.toThrow();

    expect(inspected).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('ConsoleSink routes error/warn to the matching console method', () => {
    const sink = new ConsoleSink();
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    sink.write('error', 'boom', { a: 1 });
    sink.write('warn', 'careful');
    expect(err).toHaveBeenCalledWith('diagnostic.unclassified', { schemaVersion: 1 });
    expect(warn).toHaveBeenCalledWith('careful');
    err.mockRestore();
    warn.mockRestore();
  });
});
