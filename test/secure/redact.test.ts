import { redact, redactUrls, RedactingLogger, type LogSink } from '@core/secure';

describe('redaction', () => {
  let previousDev: boolean | undefined;

  beforeEach(() => {
    previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
  });

  afterEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
  });

  it('strips the server authority and sensitive params while preserving the endpoint path', () => {
    expect(redactUrls('GET https://private.example:8443/api/v1/chat?guid=abc123&limit=10')).toBe(
      'GET https://[redacted]/api/v1/chat?guid=[redacted]&limit=10',
    );
    expect(redactUrls('socket wss://relay.private.example/socket.io/?transport=websocket')).toBe(
      'socket wss://[redacted]/socket.io/?transport=websocket',
    );
    expect(redactUrls('GET https://[fd00::1234]:8443/api/v1/ping')).toBe(
      'GET https://[redacted]/api/v1/ping',
    );
  });

  it('strips the extended sensitive query params (apikey/secret/fcmtoken) from URLs', () => {
    // These were leaking before F-25 (the URL redaction only covered guid|password|token,
    // while object-key redaction covered more — the two lists are now shared).
    expect(redactUrls('https://private.example/cb?apikey=AKIA123&page=2')).toBe(
      'https://[redacted]/cb?apikey=[redacted]&page=2',
    );
    expect(redactUrls('https://private.example/cb?secret=s3cr3t')).toBe(
      'https://[redacted]/cb?secret=[redacted]',
    );
    expect(redactUrls('https://private.example/push?fcmtoken=tok-xyz&id=9')).toBe(
      'https://[redacted]/push?fcmtoken=[redacted]&id=9',
    );
  });

  it('removes emails, recognizable phone handles and canonical UUIDs from free text', () => {
    const line = redactUrls(
      'sender alice.smith@example.com phones +1 (303) 555-0199 / 303-555-0188 message 550e8400-e29b-41d4-a716-446655440000',
    );
    expect(line).toBe('sender [redacted] phones [redacted] / [redacted] message [redacted]');
  });

  it('removes arbitrary labeled GUIDs and native-error hosts', () => {
    expect(redactUrls('chatGuid=iMessage;-;+15551234567 failed')).toBe(
      'chatGuid=[redacted] failed',
    );
    expect(redactUrls('{"messageGuid":"server-generated-id","status":500}')).toBe(
      '{"messageGuid":"[redacted]","status":500}',
    );
    expect(redactUrls('Unable to resolve host "gator.private.example" on port 443')).toBe(
      'Unable to resolve host "[redacted]" on port 443',
    );
    expect(redactUrls('error connecting to 192.168.1.24: ECONNREFUSED')).toBe(
      'error connecting to [redacted]: ECONNREFUSED',
    );
    expect(redactUrls('error connecting to gatorbox: connection refused')).toBe(
      'error connecting to [redacted]: connection refused',
    );
    expect(redactUrls('origin=https://private.example:8443/api/v1/ping')).toBe(
      'origin=https://[redacted]/api/v1/ping',
    );
  });

  it('redacts unformatted phone values only when an identity label makes them unambiguous', () => {
    expect(redactUrls('handle=3035550199 row=1234567890 timestamp=1700000009000')).toBe(
      'handle=[redacted] row=1234567890 timestamp=1700000009000',
    );
    expect(redactUrls('{"phoneNumber":"3035550199","status":500}')).toBe(
      '{"phoneNumber":"[redacted]","status":500}',
    );
  });

  it('preserves ordinary numbers, dates, endpoint paths and stack locations', () => {
    const line =
      'status=500 row=1234567890 at sync (/app/src/redact.test.ts:123:45) date=2026-08-04 timestamp=1700000009000';
    expect(redactUrls(line)).toBe(line);
  });

  it('is idempotent when a log value crosses the redacting boundary more than once', () => {
    const raw = 'origin=https://private.example/api?chatGuid=private-chat sender=alice@example.com';
    const once = redactUrls(raw);
    expect(redactUrls(once)).toBe(once);
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

  it('redacts deliberately named structured identity fields without broad key matching', () => {
    const out = redact({
      chatGuid: 'iMessage;-;private-chat',
      message_guid: 'message-private',
      faceTimeUUID: 'call-private',
      senderHandle: '+15551234567',
      participantAddress: 'alice@example.com',
      email: 'alice@example.com',
      phoneNumber: '3035550199',
      serverAddress: 'https://private.example',
      serverUrl: 'https://private.example/api',
      origin: 'https://private.example',
      host: 'private.example',
      callbackUri: 'content://private/path',
      status: 500,
      rowId: 1234567890,
      microphone: true,
      ghost: 'ordinary-category',
    }) as Record<string, unknown>;

    for (const key of [
      'chatGuid',
      'message_guid',
      'faceTimeUUID',
      'senderHandle',
      'participantAddress',
      'email',
      'phoneNumber',
      'serverAddress',
      'serverUrl',
      'origin',
      'host',
      'callbackUri',
    ]) {
      expect(out[key]).toBe('[redacted]');
    }
    expect(out).toMatchObject({
      status: 500,
      rowId: 1234567890,
      microphone: true,
      ghost: 'ordinary-category',
    });
  });

  it('handles circular references', () => {
    const a: Record<string, unknown> = { name: 'x' };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
  });

  it('flattens an Error to {name,message,stack} instead of dropping its non-enumerable fields', () => {
    // Object.entries can't see an Error's message/stack, so the legacy non-error redactor used to
    // serialize these as `{}`. Strict ERROR diagnostics deliberately ignore this raw stack.
    const err = new TypeError('bad https://x?token=abc123 thing');
    const out = redact(err) as Record<string, unknown>;
    expect(out.name).toBe('TypeError');
    expect(out.message).toBe('bad https://[redacted]?token=[redacted] thing');
    expect(typeof out.stack).toBe('string');
    expect(out.stack as string).toContain('TypeError');
    expect(out.stack as string).toContain('redact.test.ts:');
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
    log.info('connecting to https://private.example?guid=secret', {
      token: 'abc',
      host: 'private.example',
    });
    expect(writes[0]!.message).toBe('connecting to https://[redacted]?guid=[redacted]');
    expect((writes[0]!.meta as Record<string, unknown>).token).toBe('[redacted]');
    expect((writes[0]!.meta as Record<string, unknown>).host).toBe('[redacted]');
  });

  it('RedactingLogger drops hostile metadata without throwing or hiding the safe message', () => {
    const writes: { level: string; message: string; meta?: unknown }[] = [];
    const sink: LogSink = {
      write: (level, message, meta) => void writes.push({ level, message, meta }),
    };
    const log = new RedactingLogger(sink);
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('private proxy failure for alice@example.com');
        },
      },
    );

    expect(() => log.warn('[sync] bounded warning', hostile)).not.toThrow();
    expect(writes).toEqual([
      {
        level: 'warn',
        message: '[sync] bounded warning',
        meta: { redactionStatus: 'metadata_dropped' },
      },
    ]);
  });

  it('drops free-form release logs before inspecting hostile metadata', () => {
    const writes: unknown[] = [];
    const sink: LogSink = { write: (...args) => void writes.push(args) };
    const log = new RedactingLogger(sink);
    let inspected = false;
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          inspected = true;
          throw new Error('private native error');
        },
      },
    );
    const previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
    try {
      (globalThis as { __DEV__?: boolean }).__DEV__ = false;

      expect(() => log.warn('[sync] private warning', hostile)).not.toThrow();

      expect(inspected).toBe(false);
      expect(writes).toEqual([]);
    } finally {
      (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
    }
  });
});
