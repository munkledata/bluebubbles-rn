import type Database from 'better-sqlite3';
import { logSinks, type LogSink } from '@core/secure';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

// The sink drains to `getDatabase()`; point it at a per-test in-memory DB (throws when "closed").
const mockDbHolder: { db?: AppDatabase } = {};
jest.mock('@db/database', () => ({
  getDatabase: () => {
    if (!mockDbHolder.db) throw new Error('Database not initialized');
    return mockDbHolder.db;
  },
}));

// Import AFTER the mock is registered (the ordering is deliberate).
// eslint-disable-next-line import/first
import { ErrorReportSink, captureError } from '@/services/errors/errorReportSink';

const rows = (raw: Database.Database): Record<string, unknown>[] =>
  raw.prepare('SELECT level, message, stack, tag FROM error_reports ORDER BY id').all() as Record<
    string,
    unknown
  >[];
const count = (raw: Database.Database): number =>
  (raw.prepare('SELECT COUNT(*) c FROM error_reports').get() as { c: number }).c;

describe('ErrorReportSink', () => {
  let raw: Database.Database;

  beforeEach(async () => {
    jest.useFakeTimers();
    const t = await createTestDb();
    mockDbHolder.db = t.db;
    raw = t.raw;
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    mockDbHolder.db = undefined;
  });

  it('captures error level, parses the [tag] + stack, and persists on flush', async () => {
    const sink = new ErrorReportSink();
    sink.write('error', '[socket] boom', { stack: 'Error: boom\n    at foo (app:1:1)' });
    await sink.flushToDb();
    const r = rows(raw);
    expect(r.length).toBe(1);
    expect(r[0]!.tag).toBe('socket');
    expect(r[0]!.stack).toContain('at foo');
  });

  it("ignores non-error levels and the uploader's own [errorReport] logs", async () => {
    const sink = new ErrorReportSink();
    sink.write('warn', '[x] meh');
    sink.write('info', '[x] fyi');
    sink.write('error', '[errorReport] upload failed', {});
    await sink.flushToDb();
    expect(count(raw)).toBe(0);
  });

  it('buffers while the DB is closed, then persists once it opens', async () => {
    const sink = new ErrorReportSink();
    mockDbHolder.db = undefined; // DB not open
    sink.write('error', '[db] early', {});
    await sink.flushToDb(); // no-op — kept buffered
    // Open a fresh DB and confirm the buffered report flushes into it.
    const t = await createTestDb();
    mockDbHolder.db = t.db;
    await sink.flushToDb();
    expect(count(t.raw)).toBe(1);
  });

  it('captureError routes a raw Error to logger.error with an [origin] tag + redacted flattened error', () => {
    const seen: { level: string; message: string; meta?: unknown }[] = [];
    const spy: LogSink = { write: (level, message, meta) => void seen.push({ level, message, meta }) };
    logSinks.add(spy);
    captureError(new TypeError('nope https://x?token=abc'), 'uncaught');
    const rec = seen.find((s) => s.message.startsWith('[uncaught]'));
    expect(rec).toBeTruthy();
    expect(rec!.level).toBe('error');
    expect(rec!.message).toContain('TypeError');
    expect((rec!.meta as Record<string, unknown>).message).toBe('nope https://x?token=[redacted]');
  });
});
