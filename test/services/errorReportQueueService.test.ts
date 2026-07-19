import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { insertErrorReport, listRetryableErrorReports } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { runErrorReportQueue } from '@/services/errors/errorReportQueueService';
import { createTestDb } from '../support/testDb';

function fakeHttp(impl: (json: unknown) => Promise<unknown>): HttpClient {
  return {
    post: (_p: string, _s: unknown, opts: { json?: unknown }) => impl(opts?.json),
  } as unknown as HttpClient;
}
const count = (raw: Database.Database): number =>
  (raw.prepare('SELECT COUNT(*) c FROM error_reports').get() as { c: number }).c;

async function seed(db: AppDatabase, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await insertErrorReport(db, {
      level: 'error',
      message: `[t] e${i}`,
      stack: `at f${i}`,
      tag: 't',
      createdAt: 1000 + i,
    });
  }
}

describe('runErrorReportQueue', () => {
  it('uploads a batch (with device context) and deletes the rows on success', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 3);
    let sent: Record<string, unknown> | undefined;
    const http = fakeHttp(async (json) => {
      sent = json as Record<string, unknown>;
      return { ingested: 3 };
    });
    const res = await runErrorReportQueue(db, http, 5000, { appVersion: '1.2.3', platform: 'android' });
    expect(res).toEqual({ eligible: 3, uploaded: 3 });
    expect(count(raw)).toBe(0);
    expect((sent!.reports as unknown[]).length).toBe(3);
    expect(sent!.appVersion).toBe('1.2.3');
    expect((sent!.reports as Record<string, unknown>[])[0]!.tag).toBe('t');
  });

  it('marks failed + keeps rows on a network error, then succeeds after the backoff', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 1);
    const fail = fakeHttp(async () => {
      throw new ApiError('no_connection', 'down', 0);
    });
    expect(await runErrorReportQueue(db, fail, 5000)).toEqual({ eligible: 1, uploaded: 0 });
    expect(count(raw)).toBe(1);
    expect((await listRetryableErrorReports(db, 5000)).length).toBe(0); // leased + backed off
    const ok = fakeHttp(async () => ({ ingested: 1 }));
    expect((await runErrorReportQueue(db, ok, 5000 + 40_000)).uploaded).toBe(1);
    expect(count(raw)).toBe(0);
  });

  it('leaves rows buffered when the server reports ingestion disabled', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 2);
    const disabled = fakeHttp(async () => ({ ingested: 0, disabled: true }));
    expect((await runErrorReportQueue(db, disabled, 5000)).uploaded).toBe(0);
    expect(count(raw)).toBe(2); // not deleted — wait for the capability to return
  });

  it('does not double-upload when two runners race (atomic claim)', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 2);
    let uploadedTotal = 0;
    const http = fakeHttp(async (json) => {
      const n = (json as { reports: unknown[] }).reports.length;
      uploadedTotal += n;
      return { ingested: n };
    });
    const [a, b] = await Promise.all([
      runErrorReportQueue(db, http, 5000),
      runErrorReportQueue(db, http, 5000),
    ]);
    expect(a.uploaded + b.uploaded).toBe(2);
    expect(uploadedTotal).toBe(2); // each row uploaded exactly once
    expect(count(raw)).toBe(0);
  });
});
