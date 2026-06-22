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
