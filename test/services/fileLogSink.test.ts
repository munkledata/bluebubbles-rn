import { FileLogSink } from '@/services/logging/fileLogSink';

/**
 * FileLogSink's in-memory buffering (the part that's testable in Node). The actual disk I/O
 * (flush/init/clear) lazily imports expo-file-system and is device-only — not exercised here; we
 * use fake timers so the debounced flush never fires (and thus never touches the native FS).
 */
describe('FileLogSink (buffering; file I/O is device-only)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
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
});
