import { ConsoleSink, RedactingLogger, type LogSink } from '@core/secure';

describe('app logger (RedactingLogger + ConsoleSink)', () => {
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

  it('ConsoleSink suppresses debug in production but emits it in dev', () => {
    const sink = new ConsoleSink();
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const prev = (globalThis as { __DEV__?: boolean }).__DEV__;
    try {
      (globalThis as { __DEV__?: boolean }).__DEV__ = false;
      sink.write('debug', 'prod-noise');
      expect(spy).not.toHaveBeenCalled();

      (globalThis as { __DEV__?: boolean }).__DEV__ = true;
      sink.write('debug', 'dev-line');
      expect(spy).toHaveBeenCalledWith('dev-line');
    } finally {
      (globalThis as { __DEV__?: boolean }).__DEV__ = prev;
      spy.mockRestore();
    }
  });

  it('ConsoleSink routes error/warn to the matching console method', () => {
    const sink = new ConsoleSink();
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    sink.write('error', 'boom', { a: 1 });
    sink.write('warn', 'careful');
    expect(err).toHaveBeenCalledWith('boom', { a: 1 });
    expect(warn).toHaveBeenCalledWith('careful');
    err.mockRestore();
    warn.mockRestore();
  });
});
