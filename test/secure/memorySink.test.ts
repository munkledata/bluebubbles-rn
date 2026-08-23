import {
  MAX_LOG_MESSAGE_CHARS,
  MAX_LOG_META_CHARS,
  MemorySink,
  RedactingLogger,
  TeeSink,
  type LogSink,
} from '@core/secure';

describe('MemorySink (in-app log viewer buffer)', () => {
  const validTimestamp = Date.UTC(2026, 7, 6, 12, 34);
  let previousDev: boolean | undefined;

  beforeEach(() => {
    previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
  });

  afterEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
  });

  it('captures entries newest-first and clears', () => {
    const sink = new MemorySink();
    sink.write('info', 'first');
    sink.write('warn', 'second', { code: 7 });
    const entries = sink.entries();
    expect(entries.map((e) => e.message)).toEqual(['second', 'first']); // newest first
    expect(entries[0]).toMatchObject({ level: 'warn', meta: '{"code":7}' });
    sink.clear();
    expect(sink.entries()).toEqual([]);
  });

  it('caps the buffer (ring): old entries fall off', () => {
    const sink = new MemorySink();
    for (let i = 0; i < 520; i++) sink.write('info', `line ${i}`);
    const entries = sink.entries();
    expect(entries).toHaveLength(500);
    expect(entries[0]!.message).toBe('line 519'); // newest kept
    expect(entries.at(-1)!.message).toBe('line 20'); // oldest 20 dropped
  });

  it('strictly projects a hostile ERROR even when called without RedactingLogger', () => {
    const sink = new MemorySink();
    sink.write(
      'error',
      'm'.repeat(MAX_LOG_MESSAGE_CHARS + 100),
      'x'.repeat(MAX_LOG_META_CHARS + 100),
    );

    const [entry] = sink.entries();
    expect(entry).toMatchObject({
      level: 'error',
      message: 'diagnostic.unclassified',
      meta: JSON.stringify({ schemaVersion: 1 }),
    });
    expect(JSON.stringify(entry)).not.toContain('m'.repeat(100));
  });

  it('receives REDACTED lines when composed behind RedactingLogger (never raw secrets)', () => {
    const sink = new MemorySink();
    const logger = new RedactingLogger(sink);
    logger.warn('connect failed', { password: 'hunter2', host: 'example.com' });
    const [entry] = sink.entries();
    expect(entry!.meta).not.toContain('hunter2');
    expect(entry!.meta).not.toContain('example.com');
    expect(entry!.meta).toContain('[redacted]');
  });

  it('retains only structured ERROR entries in a release build', () => {
    const previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
    const sink = new MemorySink();
    try {
      (globalThis as { __DEV__?: boolean }).__DEV__ = false;
      sink.write('debug', 'private debug');
      sink.write('info', 'private info');
      sink.write('warn', 'private warning');
      sink.write('error', '[media] share failed', new TypeError('private error'));

      expect(sink.entries()).toEqual([
        {
          level: 'error',
          message: 'media.share_failed [TypeError]',
          meta: JSON.stringify({
            schemaVersion: 1,
            errorName: 'TypeError',
            stack: 'at gator.media.share_failed',
          }),
          timestamp: expect.any(Number),
        },
      ]);
    } finally {
      (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
    }
  });

  it('MemorySink drops a release non-error before serializing hostile metadata', () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    const sink = new MemorySink();
    let inspected = false;
    const hostile = {
      toJSON: () => {
        inspected = true;
        throw new Error('private');
      },
    };

    sink.write('info', 'private', hostile);

    expect(inspected).toBe(false);
    expect(sink.entries()).toEqual([]);
  });

  it('TeeSink fans a line out to every sink', () => {
    const a: string[] = [];
    const b: string[] = [];
    const mk = (arr: string[]): LogSink => ({ write: (_l, m) => void arr.push(m) });
    new TeeSink(mk(a), mk(b)).write('info', 'hello');
    expect(a).toEqual(['hello']);
    expect(b).toEqual(['hello']);
  });

  it('TeeSink.add() attaches a sink after construction (for the boot-time file sink)', () => {
    const seen: string[] = [];
    const late: LogSink = { write: (_l, m) => void seen.push(m) };
    const tee = new TeeSink({ write: () => undefined });
    tee.write('info', 'before'); // late sink not attached yet
    tee.add(late);
    tee.write('info', 'after');
    expect(seen).toEqual(['after']);
  });

  it('TeeSink strictly projects a direct ERROR before any injected child sees it', () => {
    const writes: unknown[] = [];
    const tee = new TeeSink({ write: (...args) => void writes.push(args) });

    tee.write('error', 'private failure for alice@example.com', {
      message: 'call 303-555-0199',
      stack: 'at /Users/alice/private.ts:1:2',
    });

    expect(writes).toEqual([['error', 'diagnostic.unclassified', { schemaVersion: 1 }]]);
    expect(JSON.stringify(writes)).not.toMatch(/alice@example|303-555|\/Users\/alice/);
  });

  it('TeeSink drops release non-errors before touching hostile metadata or children', () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    const child = jest.fn();
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

    new TeeSink({ write: child }).write('warn', 'private warning', hostile);

    expect(inspected).toBe(false);
    expect(child).not.toHaveBeenCalled();
  });

  it('hydrate() prepends restored (older) entries before this session and keeps newest-first order', () => {
    const sink = new MemorySink();
    sink.write('info', 'session-1');
    sink.write('info', 'session-2');
    // Restored disk history is oldest-first; it should appear BEFORE the session lines.
    sink.hydrate([
      { level: 'error', message: '[media] share failed', timestamp: validTimestamp },
      {
        level: 'error',
        message: '[socket] connection failed',
        timestamp: validTimestamp + 60_000,
      },
    ]);
    expect(sink.entries().map((e) => e.message)).toEqual([
      'session-2',
      'session-1',
      'socket.connection_failed',
      'media.share_failed',
    ]);
  });

  it('hydrate() still caps the buffer to 500 after prepending history', () => {
    const sink = new MemorySink();
    for (let i = 0; i < 400; i++) sink.write('info', `s${i}`);
    const history = Array.from({ length: 300 }, (_v, i) => ({
      level: 'error' as const,
      message: '[media] share failed',
      timestamp: validTimestamp + i * 60_000,
    }));
    sink.hydrate(history);
    expect(sink.entries()).toHaveLength(500);
    // Newest kept = the latest session line; oldest history rows fall off the front.
    expect(sink.entries()[0]!.message).toBe('s399');
  });

  it('drops legacy non-error entries supplied through hydrate()', () => {
    const sink = new MemorySink();
    sink.hydrate([
      {
        level: 'warn',
        message: 'm'.repeat(MAX_LOG_MESSAGE_CHARS + 1),
        meta: 'x'.repeat(MAX_LOG_META_CHARS + 1),
        timestamp: validTimestamp,
      },
    ]);

    expect(sink.entries()).toEqual([]);
  });

  it('strictly projects a legacy ERROR supplied directly through hydrate()', () => {
    const sink = new MemorySink();
    sink.hydrate([
      {
        level: 'error',
        message: '[socket] error connecting to private.example for alice@example.com',
        meta: JSON.stringify({ name: 'TypeError', response: 'private response' }),
        timestamp: validTimestamp + 59_999,
      },
    ]);

    expect(sink.entries()[0]).toEqual({
      level: 'error',
      message: 'socket.connection_failed [TypeError]',
      meta: JSON.stringify({
        schemaVersion: 1,
        errorName: 'TypeError',
        stack: 'at gator.socket.connection_failed',
      }),
      timestamp: validTimestamp,
    });
    expect(JSON.stringify(sink.entries()[0])).not.toMatch(
      /private\.example|alice@example|response/,
    );
  });

  it.each([3035550199, 1e300, 1.5, Date.UTC(2200, 0, 1)])(
    'drops a legacy ERROR with unsafe timestamp %s',
    (timestamp) => {
      const sink = new MemorySink();
      sink.hydrate([{ level: 'error', message: '[media] share failed', timestamp }]);
      expect(sink.entries()).toEqual([]);
    },
  );
});
