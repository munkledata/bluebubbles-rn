import type Database from 'better-sqlite3';
import { ERROR_DIAGNOSTIC_SITES, logSinks, type LogSink } from '@core/secure';
import * as errorReportRepository from '@db/repositories/errorReports';
import type { AppDatabase } from '@db/types';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
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
  raw
    .prepare('SELECT level, message, stack, tag, meta FROM error_reports ORDER BY id')
    .all() as Record<string, unknown>[];
const count = (raw: Database.Database): number =>
  (raw.prepare('SELECT COUNT(*) c FROM error_reports').get() as { c: number }).c;

describe('ErrorReportSink', () => {
  let raw: Database.Database;

  beforeEach(async () => {
    resumeRealtimeDeliveries();
    jest.useFakeTimers();
    const t = await createTestDb();
    mockDbHolder.db = t.db;
    raw = t.raw;
    useFeatureSettingsStore.setState({ errorReportingEnabled: true, hydrated: true });
  });
  afterEach(() => {
    resumeRealtimeDeliveries();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    mockDbHolder.db = undefined;
  });

  it('persists only the structured event, typed fields, and synthetic frame', async () => {
    const sink = new ErrorReportSink();
    sink.write('error', '[socket] event handling failed', {
      stack: `at gator.site.${ERROR_DIAGNOSTIC_SITES.socketEvent}`,
      event: 'new-message',
      response: 'private response for alice@example.com',
      error: {
        name: 'TypeError',
        message: 'private message for +13035550199',
        stack: 'TypeError: private\n at AlicePassport.ts:3035550:199',
      },
    });
    await sink.flushToDb();
    const r = rows(raw);
    expect(r.length).toBe(1);
    expect(r[0]!.tag).toBe('socket');
    expect(r[0]!.message).toBe('socket.event_handling_failed [event:new-message|TypeError]');
    expect(r[0]!.stack).toBe(`at gator.site.${ERROR_DIAGNOSTIC_SITES.socketEvent}`);
    expect(JSON.parse(String(r[0]!.meta))).toEqual({
      schemaVersion: 1,
      errorName: 'TypeError',
      eventName: 'new-message',
    });
    expect(JSON.stringify(r[0])).not.toMatch(
      /alice@example\.com|\+13035550199|AlicePassport|3035550199|private response|private message/,
    );
  });

  it('ignores non-error levels used by the uploader', async () => {
    const sink = new ErrorReportSink();
    sink.write('warn', '[x] meh');
    sink.write('info', '[x] fyi');
    await sink.flushToDb();
    expect(count(raw)).toBe(0);
  });

  it.each([
    ['explicitly off', false, true],
    ['not hydrated', true, false],
  ])('captures nothing when consent is %s', async (_label, enabled, hydrated) => {
    const sink = new ErrorReportSink();
    useFeatureSettingsStore.setState({ errorReportingEnabled: enabled, hydrated });

    sink.write('error', '[private] must stay out of the queue', { stack: 'secret stack' });
    await sink.flushToDb();
    await jest.advanceTimersByTimeAsync(1_000);

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

  it('rolls back a deferred account-A drain and persists only account-B reports after reset', async () => {
    const sink = new ErrorReportSink();
    const insertStarted = Promise.withResolvers<void>();
    const releaseInsert = Promise.withResolvers<void>();
    const insertBatch = errorReportRepository.insertErrorReportsWithinTransaction;
    jest
      .spyOn(errorReportRepository, 'insertErrorReportsWithinTransaction')
      .mockImplementationOnce(async (context, reports) => {
        // Let the INSERT + trim finish while their transaction is still open, then hold the
        // callback so resetSession deterministically lands before the generation's final check.
        await insertBatch(context, reports);
        insertStarted.resolve();
        await releaseInsert.promise;
      });

    sink.write('error', '[account-a] private failure');
    const accountADrain = sink.flushToDb();
    await insertStarted.promise;

    const accountAIdle = sink.resetSession();
    releaseInsert.resolve();
    await Promise.all([accountADrain, accountAIdle]);

    // The old row was physically inserted, but the generation change forced its transaction to
    // roll back. A newly connected account can now drain without inheriting account A's report.
    expect(count(raw)).toBe(0);
    sink.write('error', '[account-b] current failure');
    await sink.flushToDb();
    expect(rows(raw).map((r) => r.message)).toEqual(['diagnostic.unclassified']);
  });

  it('cancels a scheduled old-account drain when the session resets', async () => {
    const sink = new ErrorReportSink();
    sink.write('error', '[account-a] pending timer');

    await sink.resetSession();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(count(raw)).toBe(0);
  });

  it('drops diagnostics emitted after account admission closes during teardown', async () => {
    const sink = new ErrorReportSink();
    await pauseRealtimeDeliveries();
    await sink.resetSession();

    sink.write('error', '[account-a] cleanup failed after reset');
    resumeRealtimeDeliveries();
    await sink.flushToDb();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(count(raw)).toBe(0);
  });

  it('captureError reaches every logger sink as a canonical runtime diagnostic', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const seen: { level: string; message: string; meta?: unknown }[] = [];
    const spy: LogSink = {
      write: (level, message, meta) => void seen.push({ level, message, meta }),
    };
    logSinks.add(spy);
    captureError(new TypeError('nope https://x?token=abc'), 'uncaught');
    const rec = seen.find((s) => s.message.startsWith('runtime.uncaught'));
    expect(rec).toBeTruthy();
    expect(rec!.level).toBe('error');
    expect(rec!.message).toBe('runtime.uncaught [TypeError]');
    expect(rec!.meta).toEqual({
      schemaVersion: 1,
      errorName: 'TypeError',
      stack: `at gator.site.${ERROR_DIAGNOSTIC_SITES.runtimeUncaught}`,
    });
    expect(JSON.stringify(rec)).not.toMatch(/nope|https:\/\/x|token=abc/);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
