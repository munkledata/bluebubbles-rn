import { MemorySink, RedactingLogger, TeeSink, type LogSink } from '@core/secure';

describe('MemorySink (in-app log viewer buffer)', () => {
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

  it('receives REDACTED lines when composed behind RedactingLogger (never raw secrets)', () => {
    const sink = new MemorySink();
    const logger = new RedactingLogger(sink);
    logger.warn('connect failed', { password: 'hunter2', host: 'example.com' });
    const [entry] = sink.entries();
    expect(entry!.meta).not.toContain('hunter2');
    expect(entry!.meta).toContain('example.com');
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

  it('hydrate() prepends restored (older) entries before this session and keeps newest-first order', () => {
    const sink = new MemorySink();
    sink.write('info', 'session-1');
    sink.write('info', 'session-2');
    // Restored disk history is oldest-first; it should appear BEFORE the session lines.
    sink.hydrate([
      { level: 'info', message: 'disk-old', timestamp: 1 },
      { level: 'info', message: 'disk-new', timestamp: 2 },
    ]);
    expect(sink.entries().map((e) => e.message)).toEqual([
      'session-2',
      'session-1',
      'disk-new',
      'disk-old',
    ]);
  });

  it('hydrate() still caps the buffer to 500 after prepending history', () => {
    const sink = new MemorySink();
    for (let i = 0; i < 400; i++) sink.write('info', `s${i}`);
    const history = Array.from({ length: 300 }, (_v, i) => ({
      level: 'info' as const,
      message: `h${i}`,
      timestamp: i,
    }));
    sink.hydrate(history);
    expect(sink.entries()).toHaveLength(500);
    // Newest kept = the latest session line; oldest history rows fall off the front.
    expect(sink.entries()[0]!.message).toBe('s399');
  });
});
