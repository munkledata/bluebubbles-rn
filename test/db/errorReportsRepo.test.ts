import type Database from 'better-sqlite3';
import {
  ERROR_REPORT_MAX_ATTEMPTS,
  claimErrorReports,
  deleteErrorReports,
  errorReportBackoffMs,
  insertErrorReport,
  listRetryableErrorReports,
  markErrorReportsFailed,
  trimErrorReports,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

const count = (raw: Database.Database): number =>
  (raw.prepare('SELECT COUNT(*) c FROM error_reports').get() as { c: number }).c;

async function seed(db: AppDatabase, n: number, createdAt = 1000): Promise<void> {
  for (let i = 0; i < n; i++) {
    await insertErrorReport(db, { level: 'error', message: `[t] e${i}`, createdAt: createdAt + i });
  }
}

describe('errorReportBackoffMs', () => {
  it('doubles per attempt and caps at 1h', () => {
    expect(errorReportBackoffMs(1)).toBe(30_000);
    expect(errorReportBackoffMs(2)).toBe(60_000);
    expect(errorReportBackoffMs(99)).toBe(3_600_000);
  });
});

describe('error_reports repo', () => {
  it('inserts + lists eligible rows oldest-first', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 3);
    const rows = await listRetryableErrorReports(db, 5000);
    expect(rows.length).toBe(3);
    expect(rows[0]!.message).toBe('[t] e0');
    expect(count(raw)).toBe(3);
  });

  it('claim leases a row exclusively (a second claim within the lease window gets nothing)', async () => {
    const { db } = await createTestDb();
    await seed(db, 1);
    const id = (await listRetryableErrorReports(db, 5000))[0]!.id;
    expect(await claimErrorReports(db, [id], 6000)).toEqual([id]);
    expect(await claimErrorReports(db, [id], 6500)).toEqual([]); // still leased
  });

  it('markFailed schedules a backoff (not immediately retryable), then eligible after it elapses', async () => {
    const { db } = await createTestDb();
    await seed(db, 1);
    const id = (await listRetryableErrorReports(db, 5000))[0]!.id;
    await markErrorReportsFailed(db, [id], 6000);
    expect((await listRetryableErrorReports(db, 6000 + 10_000)).length).toBe(0); // 30s backoff
    expect((await listRetryableErrorReports(db, 6000 + 31_000)).length).toBe(1);
  });

  it('retires a row after the attempt cap (no infinite retry)', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 1);
    const id = (await listRetryableErrorReports(db, 5000))[0]!.id;
    let now = 6000;
    for (let i = 0; i < ERROR_REPORT_MAX_ATTEMPTS; i++) {
      await markErrorReportsFailed(db, [id], now);
      now += 3_700_000; // advance past the max backoff
    }
    expect(count(raw)).toBe(0);
  });

  it('delete removes uploaded rows', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 2);
    const ids = (await listRetryableErrorReports(db, 5000)).map((r) => r.id);
    await deleteErrorReports(db, ids);
    expect(count(raw)).toBe(0);
  });

  it('trims to the capacity cap, keeping the newest', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 5);
    await trimErrorReports(db, 3);
    expect(count(raw)).toBe(3);
    const remaining = (
      raw.prepare('SELECT message FROM error_reports ORDER BY id').all() as { message: string }[]
    ).map((r) => r.message);
    expect(remaining).toEqual(['[t] e2', '[t] e3', '[t] e4']);
  });
});
