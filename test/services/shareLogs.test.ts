import type { LogEntry } from '@core/secure';
import { formatErrorLogsForShare } from '@/services/logging/shareLogs';

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    level: 'error',
    message: '[socket] connection failed',
    timestamp: Date.UTC(2026, 7, 6, 12, 34, 56, 789),
    ...overrides,
  };
}

describe('formatErrorLogsForShare', () => {
  it('exports only strictly reprojected ERROR rows in chronological order', () => {
    const text = formatErrorLogsForShare([
      entry({
        message: '[share] capture failed: alice@example.com opened file:///private/photo.jpg',
        meta: JSON.stringify({
          error: {
            name: 'ApiError',
            kind: 'timeout',
            message: 'call alice@example.com at 303-555-0199',
            stack: 'at /Users/alice/private.ts:12:34',
          },
          password: 'raw-error-canary',
        }),
        timestamp: Date.UTC(2026, 7, 6, 12, 35, 59, 999),
      }),
      entry({
        level: 'warn',
        message: 'non-error-canary-3035550199',
        meta: 'non-error-meta-canary',
        timestamp: Date.UTC(2026, 7, 6, 12, 34, 30),
      }),
      entry({
        message: '[socket] connection failed',
        meta: JSON.stringify({
          errorName: 'TypeError',
          response: 'legacy-response-canary',
          stack: 'at /Users/bob/server.ts:98:76',
        }),
        timestamp: Date.UTC(2026, 7, 6, 12, 34, 56, 789),
      }),
    ]);

    const lines = text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toEqual([
      {
        timestamp: '2026-08-06T12:34:00.000Z',
        level: 'error',
        message: 'socket.connection_failed [TypeError]',
        stack: 'at gator.socket.connection_failed',
        tag: 'socket',
        meta: { schemaVersion: 1, errorName: 'TypeError' },
      },
      {
        timestamp: '2026-08-06T12:35:00.000Z',
        level: 'error',
        message: 'share.capture_failed [ApiError|timeout]',
        stack: 'at gator.share.capture_failed',
        tag: 'share',
        meta: { schemaVersion: 1, errorName: 'ApiError', errorCode: 'timeout' },
      },
    ]);

    for (const canary of [
      'alice@example.com',
      '303-555-0199',
      '/Users/alice',
      '/Users/bob',
      'private/photo.jpg',
      'raw-error-canary',
      'legacy-response-canary',
      'non-error-canary-3035550199',
      'non-error-meta-canary',
    ]) {
      expect(text).not.toContain(canary);
    }
  });

  it('fails closed for an unclassified legacy ERROR and an invalid timestamp', () => {
    const text = formatErrorLogsForShare([
      entry({
        message: 'private free-form failure for alice@example.com',
        meta: 'raw legacy metadata 3035550199',
        timestamp: Number.NaN,
      }),
    ]);

    expect(JSON.parse(text)).toEqual({
      timestamp: null,
      level: 'error',
      message: 'diagnostic.unclassified',
      tag: 'diagnostic',
      meta: { schemaVersion: 1 },
    });
    expect(text).not.toContain('alice@example.com');
    expect(text).not.toContain('3035550199');
  });

  it('sorts unknown times after valid rows and preserves oldest-first order for rounded ties', () => {
    const rounded = Date.UTC(2026, 7, 6, 12, 34);
    const text = formatErrorLogsForShare([
      entry({ message: '[socket] connection failed', timestamp: rounded }),
      entry({ message: '[media] share failed', timestamp: rounded }),
      entry({ message: 'private unknown event', timestamp: Number.POSITIVE_INFINITY }),
    ]);

    const rows = text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows.map((row) => row.message)).toEqual([
      'media.share_failed',
      'socket.connection_failed',
      'diagnostic.unclassified',
    ]);
    expect(rows.map((row) => row.timestamp)).toEqual([
      '2026-08-06T12:34:00.000Z',
      '2026-08-06T12:34:00.000Z',
      null,
    ]);
  });

  it('returns an empty string when the snapshot contains no ERROR rows', () => {
    expect(
      formatErrorLogsForShare([
        entry({ level: 'debug', message: 'debug canary' }),
        entry({ level: 'info', message: 'info canary' }),
        entry({ level: 'warn', message: 'warn canary' }),
      ]),
    ).toBe('');
  });
});
