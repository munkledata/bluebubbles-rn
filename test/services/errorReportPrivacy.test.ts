import {
  ERROR_DIAGNOSTIC_SITES,
  ERROR_REPORT_ENVELOPE_VERSION,
  projectCapturedErrorReport,
  projectErrorReportClientContext,
  projectErrorReportTimestamp,
  projectStoredErrorReport,
} from '@core/secure';

const parsedMeta = (report: { meta: string }): Record<string, unknown> =>
  JSON.parse(report.meta) as Record<string, unknown>;

describe('error-report structured privacy envelope', () => {
  it.each([
    [
      '[share] no cache directory available — cannot accept shared files',
      'share.no_cache_directory',
      ERROR_DIAGNOSTIC_SITES.shareNoCacheDirectory,
    ],
    [
      '[share] all shared files were unreadable',
      'share.all_files_unreadable',
      ERROR_DIAGNOSTIC_SITES.shareAllFilesUnreadable,
    ],
    ['[share] capture failed', 'share.capture_failed', ERROR_DIAGNOSTIC_SITES.shareCaptureFailed],
    [
      '[db] initialization failed',
      'db.initialization_failed',
      ERROR_DIAGNOSTIC_SITES.dbForegroundInitialization,
    ],
    [
      '[connect] database initialization failed',
      'connect.database_initialization_failed',
      ERROR_DIAGNOSTIC_SITES.connectDatabaseInitialization,
    ],
    [
      '[new-chat] createNewChat failed',
      'new_chat.create_failed',
      ERROR_DIAGNOSTIC_SITES.newChatCreate,
    ],
    [
      '[media] share source could not be protected',
      'media.share_source_unprotected',
      ERROR_DIAGNOSTIC_SITES.mediaShareSourceUnprotected,
    ],
    [
      '[media] share source is no longer available',
      'media.share_source_missing',
      ERROR_DIAGNOSTIC_SITES.mediaShareSourceMissing,
    ],
    ['[media] share failed', 'media.share_failed', ERROR_DIAGNOSTIC_SITES.mediaShare],
    [
      '[bg] background work failed',
      'background.work_failed',
      ERROR_DIAGNOSTIC_SITES.backgroundWork,
    ],
    [
      '[db] write queue appears wedged',
      'db.write_queue_wedged',
      ERROR_DIAGNOSTIC_SITES.dbWriteQueueWedge,
    ],
    [
      '[openFile] failed to open attachment',
      'open_file.open_failed',
      ERROR_DIAGNOSTIC_SITES.openFile,
    ],
    ['[ErrorBoundary] render crash', 'ui.render_crash', ERROR_DIAGNOSTIC_SITES.uiRender],
    [
      '[socket] event handling failed',
      'socket.event_handling_failed',
      ERROR_DIAGNOSTIC_SITES.socketEvent,
    ],
    [
      '[socket] connection failed',
      'socket.connection_failed',
      ERROR_DIAGNOSTIC_SITES.socketConnection,
    ],
    [
      '[lock] unlock failed after successful auth',
      'lock.unlock_failed',
      ERROR_DIAGNOSTIC_SITES.lockUnlock,
    ],
    ['[fatal] runtime error', 'runtime.fatal', ERROR_DIAGNOSTIC_SITES.runtimeFatal],
    ['[uncaught] runtime error', 'runtime.uncaught', ERROR_DIAGNOSTIC_SITES.runtimeUncaught],
    [
      '[unhandledRejection] runtime error',
      'runtime.unhandled_rejection',
      ERROR_DIAGNOSTIC_SITES.runtimeUnhandledRejection,
    ],
    [
      '[recoverable] runtime warning',
      'runtime.recoverable',
      ERROR_DIAGNOSTIC_SITES.runtimeRecoverable,
    ],
  ])('maps %s to stable event code %s and an opaque site frame', (message, expected, site) => {
    expect(projectCapturedErrorReport(message, undefined, site)).toMatchObject({
      message: expected,
      stack: `at gator.site.${site}`,
    });
  });

  it('keeps only event-owned typed diagnostics and a synthetic grouping frame', () => {
    const report = projectCapturedErrorReport(
      '[socket] event handling failed',
      {
        event: 'new-message',
        response: 'private response body',
        accountGuid: 'private-account-guid',
        error: {
          name: 'ApiError',
          kind: 'timeout',
          status: 504,
          retryable: true,
          message: 'alice@example.com at https://private.example',
          cause: { password: 'hunter2', response: 'private nested response' },
          stack:
            'ApiError: alice@example.com\n' +
            '    at deliver (/Users/alice/project/src/incomingEventDispatcher.ts:123:45)\n' +
            '    at https://private.example/app/eventRouter.ts:88:9',
        },
      },
      ERROR_DIAGNOSTIC_SITES.socketEvent,
    );

    expect(report).toEqual({
      level: 'error',
      message: 'socket.event_handling_failed [event:new-message|ApiError|timeout|http_5xx]',
      stack: `at gator.site.${ERROR_DIAGNOSTIC_SITES.socketEvent}`,
      tag: 'socket',
      meta: JSON.stringify({
        schemaVersion: ERROR_REPORT_ENVELOPE_VERSION,
        errorName: 'ApiError',
        errorCode: 'timeout',
        status: 504,
        retryable: true,
        eventName: 'new-message',
      }),
    });
    const serialized = JSON.stringify(report);
    for (const privateValue of [
      'private response body',
      'private-account-guid',
      'alice@example.com',
      'private.example',
      '/Users/alice',
      'hunter2',
      'private nested response',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('drops unknown prose, arbitrary fields, unsafe enum values, and malformed stored metadata', () => {
    const captured = projectCapturedErrorReport(
      'alice met bob beside account 3035550199 and message ordinary private words',
      {
        name: 'alice@example.com',
        code: 'PRIVATE_ACCOUNT_3035550199',
        status: 42,
        retryable: 'yes',
        event: 'attacker-controlled-event',
        fatal: 'yes',
        waiting: -1,
        body: 'ordinary private message text',
        cause: { response: 'nested private response' },
      },
    );
    const legacy = projectStoredErrorReport({
      message: '[http] POST private payload for alice@example.com',
      stack: 'Error: private\n at private@example.com.ts:1:2',
      tag: 'private-tag',
      meta: 'not-json alice@example.com +13035550199',
    });

    expect(captured).toEqual({
      level: 'error',
      message: 'diagnostic.unclassified',
      tag: 'diagnostic',
      meta: JSON.stringify({ schemaVersion: ERROR_REPORT_ENVELOPE_VERSION }),
    });
    expect(legacy).toEqual(captured);
  });

  it('keeps bounded counts only for the events that own those fields', () => {
    const share = projectCapturedErrorReport('[share] all shared files were unreadable', {
      affectedCount: 37,
    });
    expect(parsedMeta(share)).toEqual({ schemaVersion: 1, affectedCount: 37 });

    const lock = projectCapturedErrorReport('[db] write queue appears wedged', {
      waitedMs: 60_000,
      waiting: 4,
      releasedWhileWaiting: 0,
    });
    expect(parsedMeta(lock)).toEqual({
      schemaVersion: 1,
      waitedMs: 60_000,
      waiting: 4,
      releasedWhileWaiting: 0,
    });

    const rejected = projectCapturedErrorReport('[db] initialization failed', {
      waitedMs: Number.MAX_SAFE_INTEGER,
      waiting: 10_001,
      releasedWhileWaiting: Number.NaN,
    });
    expect(parsedMeta(rejected)).toEqual({ schemaVersion: 1 });

    const wrongEvent = projectCapturedErrorReport('[media] share source is no longer available', {
      name: 'ApiError',
      kind: 'timeout',
      status: 504,
      retryable: true,
      fatal: true,
      event: 'new-message',
      affectedCount: 12,
      waitedMs: 60_000,
      waiting: 4,
      releasedWhileWaiting: 3,
    });
    expect(parsedMeta(wrongEvent)).toEqual({ schemaVersion: 1 });
  });

  it('cannot inject a private filename or numeric channel through a mutable stack', () => {
    const privateStack =
      'TypeError: alice@example.com said private words\n' +
      '    at AlicePassport (/Users/alice/private/AlicePassport.ts:12:3)\n' +
      '    at phone (/tmp/diagnostic.ts:3035550:199)\n' +
      'parse@https://private.example/app/chat.ts:88:9';
    const report = projectCapturedErrorReport(
      '[media] share failed',
      {
        name: 'TypeError',
        stack: privateStack,
      },
      ERROR_DIAGNOSTIC_SITES.mediaShare,
    );

    expect(report.stack).toBe(`at gator.site.${ERROR_DIAGNOSTIC_SITES.mediaShare}`);
    expect(JSON.stringify(report)).not.toContain('AlicePassport');
    expect(JSON.stringify(report)).not.toContain('3035550199');
    expect(JSON.stringify(report)).not.toContain('private.example');
  });

  it('is idempotent when a current envelope crosses the legacy upload boundary', () => {
    const first = projectCapturedErrorReport(
      '[media] share failed',
      {
        name: 'TypeError',
        code: 'ERR_NETWORK',
        stack: 'TypeError: private\n at media.ts:96:5',
      },
      ERROR_DIAGNOSTIC_SITES.mediaShare,
    );
    const second = projectStoredErrorReport({
      ...first,
      meta: first.meta,
    });
    expect(second).toEqual(first);

    const withoutError = projectCapturedErrorReport(
      '[media] share failed',
      undefined,
      ERROR_DIAGNOSTIC_SITES.mediaShare,
    );
    expect(
      projectCapturedErrorReport(withoutError.message, {
        ...parsedMeta(withoutError),
        stack: withoutError.stack,
      }),
    ).toEqual(withoutError);
  });

  it('fails closed for missing, malformed, or cross-event site evidence', () => {
    expect(projectCapturedErrorReport('[socket] connection failed').stack).toBeUndefined();
    expect(
      projectCapturedErrorReport(
        '[socket] connection failed',
        undefined,
        's-invalid' as typeof ERROR_DIAGNOSTIC_SITES.socketConnection,
      ).stack,
    ).toBeUndefined();
    expect(
      projectCapturedErrorReport(
        '[socket] connection failed',
        { stack: `at gator.site.${ERROR_DIAGNOSTIC_SITES.socketConnection}` },
        ERROR_DIAGNOSTIC_SITES.mediaShare,
      ).stack,
    ).toBeUndefined();

    const foreground = projectCapturedErrorReport(
      '[db] initialization failed',
      undefined,
      ERROR_DIAGNOSTIC_SITES.dbForegroundInitialization,
    );
    const session = projectCapturedErrorReport(
      '[db] initialization failed',
      undefined,
      ERROR_DIAGNOSTIC_SITES.dbSessionInitialization,
    );
    expect(foreground.stack).not.toBe(session.stack);
  });

  it('preserves only an exact event-owned site frame from either durable carrier', () => {
    const frame = `at gator.site.${ERROR_DIAGNOSTIC_SITES.socketConnection}`;
    const expected = expect.objectContaining({ stack: frame });
    expect(projectStoredErrorReport({ message: 'socket.connection_failed', stack: frame })).toEqual(
      expected,
    );
    expect(
      projectStoredErrorReport({
        message: 'socket.connection_failed',
        meta: JSON.stringify({ schemaVersion: 1, stack: frame }),
      }),
    ).toEqual(expected);
    expect(
      projectStoredErrorReport({
        message: 'socket.connection_failed',
        stack: `at gator.site.${ERROR_DIAGNOSTIC_SITES.mediaShare}`,
        meta: JSON.stringify({ schemaVersion: 1, stack: 'at /Users/alice/private.ts:1:2' }),
      }).stack,
    ).toBeUndefined();
    expect(
      projectStoredErrorReport({
        message: 'socket.connection_failed',
        stack: ERROR_DIAGNOSTIC_SITES.socketConnection,
        meta: JSON.stringify({
          schemaVersion: 1,
          stack: ERROR_DIAGNOSTIC_SITES.socketConnection,
        }),
      }).stack,
    ).toBeUndefined();
    expect(
      projectStoredErrorReport({
        message: 'db.initialization_failed',
        stack: `at gator.site.${ERROR_DIAGNOSTIC_SITES.dbForegroundInitialization}`,
        meta: JSON.stringify({
          schemaVersion: 1,
          stack: `at gator.site.${ERROR_DIAGNOSTIC_SITES.dbSessionInitialization}`,
        }),
      }).stack,
    ).toBeUndefined();
  });

  it('allows only non-identifying client context buckets', () => {
    expect(
      projectErrorReportClientContext({
        appVersion: '1.2.3-beta+4',
        platform: 'android',
        osVersion: '34',
        deviceModel: "Alice's Pixel +13035550199",
      }),
    ).toEqual({ appVersion: '1.2.3-beta+4', platform: 'android', osVersion: '34' });
    expect(
      projectErrorReportClientContext({
        appVersion: '3035550199',
        platform: 'private-platform',
        osVersion: '303.555.0199',
        deviceModel: 'private-device',
      }),
    ).toEqual({});
    expect(
      projectErrorReportClientContext({
        appVersion: new String('1.2.3') as unknown as string,
        platform: new String('android') as unknown as string,
        osVersion: new String('34') as unknown as string,
      }),
    ).toEqual({});
    const hostileContext = new Proxy(
      {},
      {
        get: () => {
          throw new Error('private context getter');
        },
      },
    );
    expect(() =>
      projectErrorReportClientContext(
        hostileContext as {
          appVersion?: string;
          platform?: string;
          osVersion?: string;
        },
      ),
    ).not.toThrow();
    expect(
      projectErrorReportClientContext(
        hostileContext as {
          appVersion?: string;
          platform?: string;
          osVersion?: string;
        },
      ),
    ).toEqual({});
  });

  it('rounds plausible timestamps to a minute and rejects correlation-like numbers', () => {
    expect(projectErrorReportTimestamp(Date.UTC(2026, 7, 6, 12, 34, 56, 789))).toBe(
      Date.UTC(2026, 7, 6, 12, 34),
    );
    expect(projectErrorReportTimestamp(3035550199)).toBe(0);
    expect(projectErrorReportTimestamp(Number.NaN)).toBe(0);
  });

  it('never retains enumerated phone/account variants in any report field', () => {
    const identifiers = [
      '+13035550199',
      '303-555-0199',
      '3035550199',
      'alice@example.com',
      '550e8400-e29b-41d4-a716-446655440000',
      'https://private.example/account/alice',
      'ordinary private message words',
    ];

    for (const identifier of identifiers) {
      const report = projectCapturedErrorReport(
        `[socket] error connecting to ${identifier}: ${identifier}`,
        {
          name: identifier,
          code: identifier,
          message: identifier,
          response: identifier,
          cause: { body: identifier },
          stack: `${identifier}\n at diagnostic.ts:10:20`,
        },
        ERROR_DIAGNOSTIC_SITES.socketConnection,
      );
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain(identifier);
      expect(report.message).toBe('socket.connection_failed [UnknownError]');
      expect(report.stack).toBe(`at gator.site.${ERROR_DIAGNOSTIC_SITES.socketConnection}`);
    }
  });

  it('fails closed for generated free-form values', () => {
    let state = 0x12345678;
    const next = (): number => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    };

    for (let i = 0; i < 250; i += 1) {
      const privateValue = `private_${i}_${next().toString(36)}_${next().toString(36)}`;
      const report = projectStoredErrorReport({
        level: privateValue,
        message: `[unknown] ${privateValue}`,
        stack: `${privateValue}\nno source frame`,
        tag: privateValue,
        meta: JSON.stringify({
          message: privateValue,
          response: privateValue,
          cause: { detail: privateValue },
          arbitrary: privateValue,
        }),
      });
      expect(JSON.stringify(report)).not.toContain(privateValue);
      expect(report.message).toBe('diagnostic.unclassified');
    }
  });

  it('is bounded and no-throw for huge, deeply nested, getter, and proxy-like metadata', () => {
    const huge = 'private-value-'.repeat(100_000);
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 2_000; i += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    Object.defineProperty(deep, 'name', {
      get: () => {
        throw new Error('private getter text');
      },
    });
    const proxy = new Proxy(deep, {
      get: () => {
        throw new Error('private proxy text');
      },
    });

    expect(() =>
      projectCapturedErrorReport(
        `[socket] error connecting to ${huge}`,
        proxy,
        ERROR_DIAGNOSTIC_SITES.socketConnection,
      ),
    ).not.toThrow();
    expect(
      projectCapturedErrorReport(
        `[socket] error connecting to ${huge}`,
        proxy,
        ERROR_DIAGNOSTIC_SITES.socketConnection,
      ),
    ).toEqual({
      level: 'error',
      message: 'socket.connection_failed',
      stack: `at gator.site.${ERROR_DIAGNOSTIC_SITES.socketConnection}`,
      tag: 'socket',
      meta: JSON.stringify({ schemaVersion: 1 }),
    });
    const oversizedLegacy = projectStoredErrorReport({
      message: '[media] share failed',
      meta: JSON.stringify({ name: 'TypeError', response: huge }),
    });
    expect(oversizedLegacy.message).toBe('media.share_failed');
    expect(parsedMeta(oversizedLegacy)).toEqual({ schemaVersion: 1 });

    const hugeClassifier = projectCapturedErrorReport('[media] share failed', {
      name: 'A'.repeat(1_000_000),
    });
    expect(hugeClassifier.message).toBe('media.share_failed [UnknownError]');
  });
});
