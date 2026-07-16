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
});
