import { redact, redactUrls, RedactingLogger, type LogSink } from '@core/secure';

describe('redaction', () => {
  it('strips guid/password/token from URLs', () => {
    expect(redactUrls('GET https://x/api/v1/chat?guid=abc123&limit=10')).toBe(
      'GET https://x/api/v1/chat?guid=[redacted]&limit=10',
    );
  });

  it('strips the extended sensitive query params (apikey/secret/fcmtoken) from URLs', () => {
    // These were leaking before F-25 (the URL redaction only covered guid|password|token,
    // while object-key redaction covered more — the two lists are now shared).
    expect(redactUrls('https://x/cb?apikey=AKIA123&page=2')).toBe(
      'https://x/cb?apikey=[redacted]&page=2',
    );
    expect(redactUrls('https://x/cb?secret=s3cr3t')).toBe('https://x/cb?secret=[redacted]');
    expect(redactUrls('https://x/push?fcmtoken=tok-xyz&id=9')).toBe(
      'https://x/push?fcmtoken=[redacted]&id=9',
    );
  });

  it('redacts a bare Authorization Bearer token string', () => {
    expect(redactUrls('Authorization: Bearer hunter2-secret-pw')).toBe(
      'Authorization: Bearer [redacted]',
    );
    expect(redactUrls('headers={"Authorization":"Bearer abc.def"}')).toContain('Bearer [redacted]');
  });

  it('redacts sensitive object keys deeply', () => {
    const out = redact({
      user: 'munkle',
      password: 'hunter2',
      nested: { fcmToken: 'tok', list: [{ apiKey: 'k' }] },
    }) as Record<string, unknown>;
    expect(out.user).toBe('munkle');
    expect(out.password).toBe('[redacted]');
    const nested = out.nested as Record<string, unknown>;
    expect(nested.fcmToken).toBe('[redacted]');
    expect((nested.list as Record<string, unknown>[])[0]!.apiKey).toBe('[redacted]');
  });

  it('handles circular references', () => {
    const a: Record<string, unknown> = { name: 'x' };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
  });

  it('flattens an Error to {name,message,stack} instead of dropping its non-enumerable fields', () => {
    // Object.entries can't see an Error's message/stack, so before the Error branch these serialized
    // to `{}` — losing the stack we most want in an uploaded crash report.
    const err = new TypeError('bad https://x?token=abc123 thing');
    const out = redact(err) as Record<string, unknown>;
    expect(out.name).toBe('TypeError');
    expect(out.message).toBe('bad https://x?token=[redacted] thing');
    expect(typeof out.stack).toBe('string');
    expect(out.stack as string).toContain('TypeError');
  });

  it('redacts a nested Error carried as meta (ErrorBoundary { error, componentStack } shape)', () => {
    const err = new Error('boom Bearer sk-secret');
    const out = redact({ error: err, componentStack: 'at Foo' }) as Record<string, unknown>;
    const nested = out.error as Record<string, unknown>;
    expect(nested.message).toBe('boom Bearer [redacted]');
    expect(typeof nested.stack).toBe('string');
    expect(out.componentStack).toBe('at Foo');
  });

  it('carries an Error cause + custom own fields, redacting the sensitive ones', () => {
    const err = new Error('outer') as Error & { kind?: string; token?: string; cause?: unknown };
    err.kind = 'no_connection';
    err.token = 'sekret';
    err.cause = new Error('inner');
    const out = redact(err) as Record<string, unknown>;
    expect(out.kind).toBe('no_connection');
    expect(out.token).toBe('[redacted]');
    expect((out.cause as Record<string, unknown>).message).toBe('inner');
  });

  it('RedactingLogger redacts both message and meta before writing', () => {
    const writes: { level: string; message: string; meta?: unknown }[] = [];
    const sink: LogSink = {
      write: (level, message, meta) => void writes.push({ level, message, meta }),
    };
    const log = new RedactingLogger(sink);
    log.info('connecting to https://x?guid=secret', { token: 'abc', host: 'x' });
    expect(writes[0]!.message).toBe('connecting to https://x?guid=[redacted]');
    expect((writes[0]!.meta as Record<string, unknown>).token).toBe('[redacted]');
    expect((writes[0]!.meta as Record<string, unknown>).host).toBe('x');
  });
});
