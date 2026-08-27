// `flushErrorReports` (below) lives in services/errors/index, which pulls expo-constants,
// react-native and the native DB handle. Stub ONLY those leaves — the queue service, the session
// store and the feature-settings store under test stay real.
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '0.1.30' } },
}));
jest.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 34, constants: { Model: 'Pixel 9' } },
}));
jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/clients', () => ({ http: { post: jest.fn() } }));
jest.mock('@/services/errors/errorReportSink', () => ({
  errorReportSink: {
    flushToDb: jest.fn(async () => {}),
    resetSession: jest.fn(async () => {}),
  },
  captureError: jest.fn(),
}));
jest.mock('@/services/errors/globalErrorHandlers', () => ({
  installGlobalErrorHandlers: jest.fn(),
}));

import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import type { ServerInfo } from '@core/models';
import { ERROR_DIAGNOSTIC_SITES, logger } from '@core/secure';
import { insertErrorReport, kvSet, listRetryableErrorReports } from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { ERROR_REPORTING_CONSENT_KEY, useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useSessionStore } from '@state/sessionStore';
import { flushErrorReports, initErrorReporting } from '@/services/errors';
import { runErrorReportQueue } from '@/services/errors/errorReportQueueService';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { createTestDb } from '../support/testDb';

const { getDatabase: mockGetDatabase } = jest.requireMock('@db/database') as {
  getDatabase: jest.Mock;
};
const { http: mockHttp } = jest.requireMock('@/services/clients') as { http: { post: jest.Mock } };
const { errorReportSink: mockSink } = jest.requireMock('@/services/errors/errorReportSink') as {
  errorReportSink: { flushToDb: jest.Mock; resetSession: jest.Mock };
};

function fakeHttp(impl: (json: unknown, signal?: AbortSignal) => Promise<unknown>): HttpClient {
  return {
    post: (_p: string, _s: unknown, opts: { json?: unknown; signal?: AbortSignal }) =>
      impl(opts?.json, opts?.signal),
  } as unknown as HttpClient;
}
const count = (raw: Database.Database): number =>
  (raw.prepare('SELECT COUNT(*) c FROM error_reports').get() as { c: number }).c;

async function seed(db: AppDatabase, n: number, now = Date.now()): Promise<void> {
  for (let i = 0; i < n; i++) {
    await insertErrorReport(
      db,
      {
        level: 'error',
        message: '[media] share failed',
        stack: `at gator.site.${ERROR_DIAGNOSTIC_SITES.mediaShare}`,
        tag: 'media',
        createdAt: now - n + i,
      },
      now,
    );
  }
}

interface ObservedLease {
  lease: RealtimeDeliveryLease;
  waitForChecks(count: number): Promise<void>;
}

function observeLease(base: RealtimeDeliveryLease): ObservedLease {
  let checks = 0;
  const waiters: { count: number; resolve: () => void }[] = [];
  const notify = (): void => {
    for (const waiter of [...waiters]) {
      if (checks < waiter.count) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  return {
    lease: {
      generation: base.generation,
      isCurrent: () => {
        checks += 1;
        notify();
        return base.isCurrent();
      },
    },
    waitForChecks: async (count) => {
      if (checks >= count) return;
      await new Promise<void>((resolve) => waiters.push({ count, resolve }));
    },
  };
}

async function holdDbTransaction(db: AppDatabase): Promise<{
  release(): void;
  finished: Promise<void>;
}> {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finished = withDbTransaction(db, async () => {
    entered();
    await blocked;
  });
  await started;
  return { release, finished };
}

async function holdRollingBackDbTransaction(db: AppDatabase): Promise<{
  release(): void;
  failure: Promise<unknown>;
}> {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const failure = withDbTransaction(db, async () => {
    entered();
    await blocked;
    throw new Error('error-report clock neighbour rollback');
  }).then(
    () => null,
    (error: unknown) => error,
  );
  await started;
  return { release, failure };
}

const nextEventLoopTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

async function waitForCondition(check: () => boolean, label: string): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    if (check()) return;
    await nextEventLoopTurn();
  }
  throw new Error(`${label} did not settle within 20 event-loop turns`);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => resumeRealtimeDeliveries());
afterEach(() => resumeRealtimeDeliveries());

describe('runErrorReportQueue', () => {
  it('uploads a batch (with device context) and deletes the rows on success', async () => {
    const { db, raw } = await createTestDb();
    const uploadNow = Date.UTC(2026, 7, 6, 12, 34, 56, 789);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(uploadNow);
    try {
      await seed(db, 3, uploadNow);
      let sent: Record<string, unknown> | undefined;
      const http = fakeHttp(async (json) => {
        expect(raw.inTransaction).toBe(false);
        sent = json as Record<string, unknown>;
        return { ingested: 3 };
      });
      const res = await runErrorReportQueue(db, http, uploadNow, {
        appVersion: '1.2.3',
        platform: 'android',
      });
      expect(res).toEqual({ eligible: 3, uploaded: 3 });
      expect(count(raw)).toBe(0);
      const expectedReport = {
        level: 'error',
        message: 'media.share_failed',
        stack: `at gator.site.${ERROR_DIAGNOSTIC_SITES.mediaShare}`,
        tag: 'media',
        meta: JSON.stringify({ schemaVersion: 1 }),
        timestamp: Date.UTC(2026, 7, 6, 12, 34),
      };
      expect(sent).toEqual({
        reports: [expectedReport, expectedReport, expectedReport],
        appVersion: '1.2.3',
        platform: 'android',
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('rebuilds legacy JSON/malformed rows into the strict envelope at the HTTP boundary', async () => {
    const { db } = await createTestDb();
    const uploadNow = Date.now();
    await insertErrorReport(
      db,
      {
        level: 'error',
        message:
          '[socket] error connecting to old.private.example: failed for alice@example.com id 550e8400-e29b-41d4-a716-446655440000',
        stack:
          'Error: host=old.private.example\n    at send (/app/src/send.ts:123:45)\n    at https://old.private.example/api/v1/message',
        tag: 'http',
        meta: JSON.stringify({
          host: 'old.private.example',
          phoneNumber: '3035550199',
          detail: 'sender alice@example.com',
          name: 'ApiError',
          kind: 'no_connection',
          status: 503,
        }),
        createdAt: uploadNow - 2,
      },
      uploadNow,
    );
    await insertErrorReport(
      db,
      {
        level: 'error',
        message: '[share] capture failed: +13035550199 could not be copied',
        tag: 'share',
        meta: 'Unable to resolve host "old.private.example" for +13035550199',
        createdAt: uploadNow - 1,
      },
      uploadNow,
    );
    let sent: { reports: Array<Record<string, unknown>> } | undefined;
    const http = fakeHttp(async (json) => {
      sent = json as { reports: Array<Record<string, unknown>> };
      return { ingested: 2 };
    });

    await runErrorReportQueue(db, http, uploadNow);

    const [jsonReport, fallbackReport] = sent?.reports ?? [];
    expect(jsonReport?.message).toBe('socket.connection_failed [ApiError|no_connection|http_5xx]');
    expect(jsonReport?.stack).toBeUndefined();
    expect(JSON.parse(String(jsonReport?.meta))).toEqual({
      schemaVersion: 1,
      errorName: 'ApiError',
      errorCode: 'no_connection',
      status: 503,
    });
    expect(fallbackReport).toMatchObject({
      message: 'share.capture_failed',
      tag: 'share',
      meta: JSON.stringify({ schemaVersion: 1 }),
    });
    expect(JSON.stringify(sent)).not.toMatch(
      /old\.private\.example|alice@example\.com|550e8400|3035550199|\+13035550199|Unable to resolve/,
    );
  });

  it('uses the rounded upload minute when a legacy capture timestamp is invalid', async () => {
    const { db } = await createTestDb();
    const uploadNow = Date.UTC(2026, 7, 6, 12, 34, 56, 789);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(uploadNow);
    try {
      await insertErrorReport(
        db,
        {
          level: 'error',
          message: '[media] share failed',
          // SQLite can retain a REAL in an INTEGER-affinity legacy column. This value is recent
          // enough to upload but is intentionally not a safe integer accepted by the projector.
          createdAt: uploadNow - 500.5,
        },
        uploadNow,
      );
      let sent: { reports: Array<{ timestamp: number }> } | undefined;
      const http = fakeHttp(async (json) => {
        sent = json as { reports: Array<{ timestamp: number }> };
        return { ingested: 1 };
      });

      await runErrorReportQueue(db, http, uploadNow);

      expect(sent?.reports[0]?.timestamp).toBe(Date.UTC(2026, 7, 6, 12, 34));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('starts a slow failed upload backoff from its live failure time, then retries at the boundary', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const { db, raw } = await createTestDb();
    const startedAt = 1_000_000;
    const failedAt = startedAt + 30_001;
    const retryAt = failedAt + 30_000;
    await seed(db, 1, startedAt);
    let wallNow = startedAt;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => wallNow);
    const response = deferred<never>();
    let postStarted = false;
    const fail = fakeHttp(async () => {
      expect(raw.inTransaction).toBe(false);
      postStarted = true;
      return response.promise;
    });
    let runSettled = false;
    const runOutcome = runErrorReportQueue(db, fail, startedAt)
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        runSettled = true;
      });

    try {
      await waitForCondition(
        () => postStarted || runSettled,
        'slow error-report upload before failure',
      );
      expect(postStarted).toBe(true);
      expect(runSettled).toBe(false);

      wallNow = failedAt;
      response.reject(new ApiError('no_connection', 'down', 0));
      await expect(runOutcome).resolves.toEqual({
        kind: 'resolved',
        value: { eligible: 1, uploaded: 0 },
      });
      expect(
        raw.prepare('SELECT attempts, next_retry_at AS nextRetryAt FROM error_reports').get(),
      ).toEqual({ attempts: 1, nextRetryAt: retryAt });
      expect(await listRetryableErrorReports(db, () => retryAt - 1)).toEqual([]);
      await expect(listRetryableErrorReports(db, () => retryAt)).resolves.toHaveLength(1);

      wallNow = retryAt;
      const ok = fakeHttp(async () => ({ ingested: 1 }));
      await expect(runErrorReportQueue(db, ok, retryAt)).resolves.toEqual({
        eligible: 1,
        uploaded: 1,
      });
      expect(count(raw)).toBe(0);
      expect(warn).toHaveBeenCalledWith('[errorReport] upload failed', expect.any(ApiError));
    } finally {
      response.reject(new ApiError('no_connection', 'cleanup', 0));
      await Promise.allSettled([runOutcome]);
      nowSpy.mockRestore();
      warn.mockRestore();
    }
  });

  it('leaves rows buffered when the server reports ingestion disabled', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 2);
    const disabled = fakeHttp(async () => ({ ingested: 0, disabled: true }));
    expect((await runErrorReportQueue(db, disabled, 5000)).uploaded).toBe(0);
    expect(count(raw)).toBe(2); // not deleted — wait for the capability to return
  });

  it.each([0, 1])(
    'retains and backs off the whole batch when the server acknowledges only %i of 2 rows',
    async (ingested) => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      const { db, raw } = await createTestDb();
      await seed(db, 2);
      const partial = fakeHttp(async () => ({ ingested }));

      expect(await runErrorReportQueue(db, partial, 5_000)).toEqual({
        eligible: 2,
        uploaded: 0,
      });
      expect(count(raw)).toBe(2);
      expect(
        raw.prepare('SELECT attempts FROM error_reports ORDER BY id').all() as Array<{
          attempts: number;
        }>,
      ).toEqual([{ attempts: 1 }, { attempts: 1 }]);
      expect(warn).toHaveBeenCalledWith('[errorReport] upload failed', expect.any(Error));
      warn.mockRestore();
    },
  );

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

  it('starts a queued claim lease from its live post-lock clock', async () => {
    const { db, raw } = await createTestDb();
    const startedAt = 1_000_000;
    const leaseMs = 120_000;
    await seed(db, 1, startedAt);
    raw.prepare('UPDATE error_reports SET next_retry_at = ?').run(startedAt + 1);
    const neighbour = await holdRollingBackDbTransaction(db);
    let wallNow = startedAt;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => wallNow);
    const response = deferred<{ ingested: number }>();
    let postCalls = 0;
    const http = fakeHttp(async () => {
      postCalls += 1;
      return response.promise;
    });
    let firstSettled = false;
    let firstOutcome:
      | Promise<
          | { kind: 'resolved'; value: { eligible: number; uploaded: number } }
          | { kind: 'rejected'; error: unknown }
        >
      | undefined;
    const competitorOutcomes: Array<Promise<unknown>> = [];

    try {
      firstOutcome = runErrorReportQueue(db, http, startedAt)
        .then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        )
        .finally(() => {
          firstSettled = true;
        });
      await nextEventLoopTurn();
      expect(firstSettled).toBe(false);
      expect(postCalls).toBe(0);
      expect(raw.prepare('SELECT next_retry_at AS nextRetryAt FROM error_reports').get()).toEqual({
        nextRetryAt: startedAt + 1,
      });

      const acquiredAt = startedAt + leaseMs + 1;
      wallNow = acquiredAt;
      neighbour.release();
      expect(String(await neighbour.failure)).toContain('error-report clock neighbour rollback');
      await waitForCondition(
        () => postCalls > 0 || firstSettled,
        'first error-report upload after queued claim',
      );
      expect(firstSettled).toBe(false);
      expect(postCalls).toBe(1);
      expect(raw.prepare('SELECT next_retry_at AS nextRetryAt FROM error_reports').get()).toEqual({
        nextRetryAt: acquiredAt + leaseMs,
      });

      for (const probeAt of [acquiredAt, acquiredAt + leaseMs - 1]) {
        wallNow = probeAt;
        let competitorSettled = false;
        const competitorOutcome = runErrorReportQueue(db, http, probeAt)
          .then(
            (value) => ({ kind: 'resolved' as const, value }),
            (error: unknown) => ({ kind: 'rejected' as const, error }),
          )
          .finally(() => {
            competitorSettled = true;
          });
        competitorOutcomes.push(competitorOutcome);
        await waitForCondition(
          () => competitorSettled || postCalls > 1,
          `competing error-report run at ${probeAt}`,
        );
        expect(postCalls).toBe(1);
        await expect(competitorOutcome).resolves.toEqual({
          kind: 'resolved',
          value: { eligible: 0, uploaded: 0 },
        });
      }

      response.resolve({ ingested: 1 });
      await expect(firstOutcome).resolves.toEqual({
        kind: 'resolved',
        value: { eligible: 1, uploaded: 1 },
      });
      expect(count(raw)).toBe(0);
    } finally {
      neighbour.release();
      response.resolve({ ingested: 1 });
      const drains: Promise<unknown>[] = [neighbour.failure, ...competitorOutcomes];
      if (firstOutcome) drains.push(firstOutcome);
      await Promise.allSettled(drains);
      nowSpy.mockRestore();
    }
  });
});

describe('runErrorReportQueue account teardown', () => {
  it('never turns queued A cleanup into a B claim or POST after pause + reconnect', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 1);
    let account = 'A';
    const postedAccounts: string[] = [];
    const http = fakeHttp(async () => {
      postedAccounts.push(account);
      return { ingested: 1 };
    });
    const observed = observeLease(captureRealtimeDeliveryLease());
    const held = await holdDbTransaction(db);
    const pending = runErrorReportQueue(db, http, 5_000, {}, observed.lease);

    // The first two checks admit the outer runner and its queue body. Before the call returns, the
    // read-boundary cleanup synchronously claims a mutex slot behind `held`; its commit guard cannot
    // run until that lock opens. Revoke here to prove the queued cleanup rolls back before listing,
    // claiming, or posting any row from the newly connected account.
    await observed.waitForChecks(2);
    const drain = pauseRealtimeDeliveries();
    account = 'B';
    resumeRealtimeDeliveries();
    held.release();
    await held.finished;

    await expect(pending).resolves.toEqual({ eligible: 0, uploaded: 0 });
    await drain;
    expect(postedAccounts).toEqual([]);
    expect((await listRetryableErrorReports(db, Date.now)).length).toBe(1);
    expect(count(raw)).toBe(1);
  });

  it('rejects a successful delete outcome that was queued before pause', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 1);
    const observed = observeLease(captureRealtimeDeliveryLease());
    let held: Awaited<ReturnType<typeof holdDbTransaction>> | undefined;
    const http = fakeHttp(async () => {
      // Claim has committed. Hold a new transaction while the response returns so the success
      // outcome is admitted but cannot acquire the mutex until after account revocation.
      held = await holdDbTransaction(db);
      return { ingested: 1 };
    });
    const pending = runErrorReportQueue(db, http, 5_000, {}, observed.lease);

    // Read cleanup + claim each add three last-moment transaction checks. Check 13 is the success
    // outcome's tracked admission; its task synchronously queues DELETE behind `held`.
    await observed.waitForChecks(13);
    const drain = pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    if (!held) throw new Error('expected the success outcome lock to be held');
    held.release();
    await held.finished;

    await expect(pending).resolves.toEqual({ eligible: 1, uploaded: 0 });
    await drain;
    expect(count(raw)).toBe(1);
  });

  it('rejects a failure mark outcome that was queued before pause', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const { db, raw } = await createTestDb();
    await seed(db, 1);
    const observed = observeLease(captureRealtimeDeliveryLease());
    let held: Awaited<ReturnType<typeof holdDbTransaction>> | undefined;
    const http = fakeHttp(async () => {
      held = await holdDbTransaction(db);
      throw new ApiError('no_connection', 'A failed', 0);
    });
    const pending = runErrorReportQueue(db, http, 5_000, {}, observed.lease);

    // Same sequence as the success case: check 13 admits the failure-mark transaction and queues
    // it behind `held`, where account revocation must reject it before BEGIN.
    await observed.waitForChecks(13);
    const drain = pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    if (!held) throw new Error('expected the failure outcome lock to be held');
    held.release();
    await held.finished;

    await expect(pending).resolves.toEqual({ eligible: 1, uploaded: 0 });
    await drain;
    expect(raw.prepare('SELECT attempts FROM error_reports').get() as { attempts: number }).toEqual(
      { attempts: 0 },
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps an upload already begun on A and cannot delete B rows after A succeeds', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 1);
    let account = 'A';
    const response = deferred<{ ingested: number }>();
    const started = deferred<void>();
    const postedAccounts: string[] = [];
    const http = fakeHttp(async () => {
      // This synchronous read models HttpClient's immutable per-request transport snapshot.
      postedAccounts.push(account);
      started.resolve();
      return response.promise;
    });
    const lease = captureRealtimeDeliveryLease();
    const pending = runErrorReportQueue(db, http, 5_000, {}, lease);
    await started.promise;

    let drainSettled = false;
    const drain = pauseRealtimeDeliveries().then(() => {
      drainSettled = true;
    });
    await Promise.resolve();
    expect(drainSettled).toBe(false); // Disconnect can see and wait for the admitted POST.

    // Model the bounded-timeout path: teardown proceeds with the lease already revoked, wipes A,
    // then B reconnects while the old native request is still outstanding.
    raw.prepare('DELETE FROM error_reports').run();
    account = 'B';
    resumeRealtimeDeliveries();
    await insertErrorReport(
      db,
      { level: 'error', message: '[b] keep me', createdAt: 9_000 },
      9_000,
    );
    const allAfterWipe = jest.spyOn(db, 'all');
    const runAfterWipe = jest.spyOn(db, 'run');

    response.resolve({ ingested: 1 });
    await expect(pending).resolves.toEqual({ eligible: 1, uploaded: 0 });
    await drain;

    expect(postedAccounts).toEqual(['A']);
    expect(allAfterWipe).not.toHaveBeenCalled();
    expect(runAfterWipe).not.toHaveBeenCalled();
    expect(
      raw.prepare('SELECT message, attempts FROM error_reports').all() as {
        message: string;
        attempts: number;
      }[],
    ).toEqual([{ message: '[b] keep me', attempts: 0 }]);
    allAfterWipe.mockRestore();
    runAfterWipe.mockRestore();
  });

  it('cannot mark B rows failed when A rejects after the wipe', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const { db, raw } = await createTestDb();
    await seed(db, 1);
    let account = 'A';
    const response = deferred<never>();
    const started = deferred<void>();
    const postedAccounts: string[] = [];
    const http = fakeHttp(async () => {
      postedAccounts.push(account);
      started.resolve();
      return response.promise;
    });
    const pending = runErrorReportQueue(db, http, 5_000, {}, captureRealtimeDeliveryLease());
    await started.promise;

    const drain = pauseRealtimeDeliveries();
    raw.prepare('DELETE FROM error_reports').run();
    account = 'B';
    resumeRealtimeDeliveries();
    await insertErrorReport(
      db,
      { level: 'error', message: '[b] keep me', createdAt: 9_000 },
      9_000,
    );
    const allAfterWipe = jest.spyOn(db, 'all');
    const runAfterWipe = jest.spyOn(db, 'run');

    response.reject(new ApiError('no_connection', 'A is gone', 0));
    await expect(pending).resolves.toEqual({ eligible: 1, uploaded: 0 });
    await drain;

    expect(postedAccounts).toEqual(['A']);
    expect(allAfterWipe).not.toHaveBeenCalled();
    expect(runAfterWipe).not.toHaveBeenCalled();
    expect(
      raw.prepare('SELECT message, attempts FROM error_reports').all() as {
        message: string;
        attempts: number;
      }[],
    ).toEqual([{ message: '[b] keep me', attempts: 0 }]);
    expect(warn).not.toHaveBeenCalled();
    allAfterWipe.mockRestore();
    runAfterWipe.mockRestore();
    warn.mockRestore();
  });
});

/**
 * `flushErrorReports` is the only thing deciding whether captured crash data ever LEAVES the
 * device. Each of its three gates is a separate promise to the user — "we have nowhere to send it",
 * "your server doesn't accept uploads", "you turned this off" — and a deleted gate is invisible:
 * the queue keeps working, the suite keeps passing, and reports quietly start shipping.
 *
 * The real queue runs here (not a mock), so "no upload" is proved by the strongest available
 * evidence: no HTTP POST at all, and the buffered rows still sitting in the DB afterwards.
 */
describe('flushErrorReports gates', () => {
  const CONNECTED = { origin: 'https://srv.example.com', password: 'pw' };
  const capable = { supports_error_log_upload: true } as unknown as ServerInfo;
  const notCapable = { supports_error_log_upload: false } as unknown as ServerInfo;

  let db: AppDatabase;
  let raw: Database.Database;

  beforeAll(() => {
    useFeatureSettingsStore.setState({ errorReportingEnabled: false, hydrated: false });
    initErrorReporting();
  });

  beforeEach(async () => {
    ({ db, raw } = await createTestDb());
    await seed(db, 2, Date.now());
    mockGetDatabase.mockReturnValue(db);
    mockHttp.post.mockResolvedValue({ ingested: 2 });
    // Fully-open state; each test then closes exactly one gate.
    useSessionStore.setState({ ...CONNECTED, serverInfo: capable });
    useFeatureSettingsStore.setState({ errorReportingEnabled: true, hydrated: true });
  });

  it('uploads when every gate is open (control — proves the gate tests can fail)', async () => {
    await flushErrorReports();
    expect(mockSink.flushToDb).toHaveBeenCalled();
    expect(mockHttp.post).toHaveBeenCalledTimes(1);
    expect(count(raw)).toBe(0); // rows shipped and deleted
  });

  it('admits one shared flush while a consent purge is still settling', async () => {
    const reportsIdle = deferred<void>();
    mockSink.resetSession.mockImplementationOnce(() => reportsIdle.promise);
    useFeatureSettingsStore.setState({ errorReportingEnabled: false, hydrated: true });
    useFeatureSettingsStore.setState({ errorReportingEnabled: true, hydrated: true });

    const first = flushErrorReports();
    const second = flushErrorReports();
    reportsIdle.resolve();
    await Promise.all([first, second]);

    expect(mockSink.flushToDb).toHaveBeenCalledTimes(1);
    expect(mockHttp.post).not.toHaveBeenCalled();
    expect(count(raw)).toBe(0);
  });

  it('purges the database captured at revocation instead of a later current database', async () => {
    const accountA = { db, raw };
    const accountB = await createTestDb();
    await seed(accountB.db, 1, Date.now());
    const reportsIdle = deferred<void>();
    mockSink.resetSession.mockImplementationOnce(() => reportsIdle.promise);

    useFeatureSettingsStore.setState({ errorReportingEnabled: false, hydrated: true });
    mockGetDatabase.mockReturnValue(accountB.db);
    reportsIdle.resolve();
    await waitForCondition(
      () => count(accountA.raw) === 0 || count(accountB.raw) === 0,
      'captured error-report purge',
    );

    expect(count(accountA.raw)).toBe(0);
    expect(count(accountB.raw)).toBe(1);
  });

  it('does not let a retired purge clear account B on the reused database handle', async () => {
    const reportsIdle = deferred<void>();
    mockSink.resetSession.mockImplementationOnce(() => reportsIdle.promise);

    useFeatureSettingsStore.setState({ errorReportingEnabled: false, hydrated: true });
    await pauseRealtimeDeliveries();
    raw.prepare('DELETE FROM error_reports').run();
    await seed(db, 1, Date.now());
    resumeRealtimeDeliveries();
    reportsIdle.resolve();
    await nextEventLoopTurn();
    await nextEventLoopTurn();

    expect(count(raw)).toBe(1);

    // Satisfy the retained purge barrier so later tests start from a neutral module state.
    useFeatureSettingsStore.setState({ errorReportingEnabled: true, hydrated: true });
    await flushErrorReports();
    expect(count(raw)).toBe(0);
  });

  it('retires and purges a second account even while the first purge is pending', async () => {
    const accountA = { db, raw };
    const accountB = await createTestDb();
    await seed(accountB.db, 1, Date.now());
    const accountAIdle = deferred<void>();
    mockSink.resetSession.mockImplementationOnce(() => accountAIdle.promise);

    useFeatureSettingsStore.setState({ errorReportingEnabled: false, hydrated: true });
    useFeatureSettingsStore.setState({ errorReportingEnabled: true, hydrated: true });
    mockGetDatabase.mockReturnValue(accountB.db);
    useFeatureSettingsStore.setState({ errorReportingEnabled: false, hydrated: true });
    expect(mockSink.resetSession).toHaveBeenCalledTimes(2);

    accountAIdle.resolve();
    await waitForCondition(
      () => count(accountA.raw) === 0 && count(accountB.raw) === 0,
      'two-account error-report purge',
    );
  });

  it('quarantines revoked rows until a failed purge can be retried successfully', async () => {
    const run = jest.spyOn(db, 'run').mockRejectedValueOnce(new Error('purge failed'));

    useFeatureSettingsStore.setState({ errorReportingEnabled: false, hydrated: true });
    await waitForCondition(() => run.mock.calls.length === 1, 'failed error-report purge');
    await nextEventLoopTurn();
    useFeatureSettingsStore.setState({ errorReportingEnabled: true, hydrated: true });

    await flushErrorReports();

    expect(mockHttp.post).not.toHaveBeenCalled();
    expect(count(raw)).toBe(0);

    await seed(db, 1, Date.now());
    mockHttp.post.mockResolvedValueOnce({ ingested: 1 });
    await flushErrorReports();
    expect(mockHttp.post).toHaveBeenCalledTimes(1);
    expect(count(raw)).toBe(0);
    run.mockRestore();
  });

  it('captures A before the in-memory drain and never starts a B request afterward', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    mockSink.flushToDb.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });

    const pending = flushErrorReports();
    await entered.promise;
    const drain = pauseRealtimeDeliveries();
    useSessionStore.setState({
      origin: 'https://b.example.com',
      password: 'b-password',
      serverInfo: capable,
    });
    resumeRealtimeDeliveries();
    release.resolve();

    await pending;
    await drain;
    expect(mockHttp.post).not.toHaveBeenCalled();
    expect(count(raw)).toBe(2);
  });

  it('captures A before consent hydration and cannot resume as account B', async () => {
    const enteredHydration = deferred<void>();
    const releaseHydration = deferred<void>();
    const originalHydrate = useFeatureSettingsStore.getState().hydrate;
    useFeatureSettingsStore.setState({
      errorReportingEnabled: false,
      hydrated: false,
      hydrate: async (options) => {
        enteredHydration.resolve();
        await releaseHydration.promise;
        if (options?.shouldCommit?.() ?? true) {
          useFeatureSettingsStore.setState({ errorReportingEnabled: true, hydrated: true });
        }
      },
    });

    try {
      const pending = flushErrorReports();
      await enteredHydration.promise;
      await pauseRealtimeDeliveries();
      const accountB = await createTestDb();
      await seed(accountB.db, 1, Date.now());
      mockGetDatabase.mockReturnValue(accountB.db);
      useSessionStore.setState({
        origin: 'https://b.example.com',
        password: 'b-password',
        serverInfo: capable,
      });
      resumeRealtimeDeliveries();
      releaseHydration.resolve();
      await pending;

      expect(mockSink.flushToDb).not.toHaveBeenCalled();
      expect(mockHttp.post).not.toHaveBeenCalled();
      expect(count(accountB.raw)).toBe(1);
    } finally {
      useFeatureSettingsStore.setState({ hydrate: originalHydrate });
    }
  });

  it('uploads nothing when there are no credentials (not connected)', async () => {
    useSessionStore.setState({ origin: null, password: null });
    await flushErrorReports();
    expect(mockHttp.post).not.toHaveBeenCalled();
    expect(mockSink.flushToDb).not.toHaveBeenCalled(); // gated before the buffer is even persisted
    expect(count(raw)).toBe(2);
  });

  it('uploads nothing when the origin is present but the password is missing', async () => {
    useSessionStore.setState({ ...CONNECTED, password: null });
    await flushErrorReports();
    expect(mockHttp.post).not.toHaveBeenCalled();
    expect(count(raw)).toBe(2);
  });

  it('uploads nothing when the server does not advertise supports_error_log_upload', async () => {
    useSessionStore.setState({ ...CONNECTED, serverInfo: notCapable });
    await flushErrorReports();
    expect(mockHttp.post).not.toHaveBeenCalled();
    expect(count(raw)).toBe(2);
  });

  it('uploads nothing when the server capability is absent entirely (older server)', async () => {
    useSessionStore.setState({ ...CONNECTED, serverInfo: null });
    await flushErrorReports();
    expect(mockHttp.post).not.toHaveBeenCalled();
    expect(count(raw)).toBe(2);
  });

  it('aborts an in-flight upload and purges its queue when consent is revoked', async () => {
    const started = deferred<void>();
    let uploadSignal: AbortSignal | undefined;
    mockHttp.post.mockImplementationOnce(
      async (_path: string, _schema: unknown, opts: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          uploadSignal = opts.signal;
          started.resolve();
          opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );

    const pending = flushErrorReports();
    await started.promise;
    const lease = captureRealtimeDeliveryLease();
    const disabling = useFeatureSettingsStore.getState().setErrorReportingConsent(false, {
      db,
      shouldCommit: () => lease.isCurrent(),
    });

    expect(uploadSignal?.aborted).toBe(true);
    await Promise.all([pending, disabling]);
    await flushErrorReports(); // joins the revocation purge if its DB lock is still queued

    expect(count(raw)).toBe(0);
    expect(mockHttp.post).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight upload when account teardown retires its generation', async () => {
    const started = deferred<void>();
    let uploadSignal: AbortSignal | undefined;
    mockHttp.post.mockImplementationOnce(
      async (_path: string, _schema: unknown, opts: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          uploadSignal = opts.signal;
          started.resolve();
          opts.signal?.addEventListener('abort', () => reject(new Error('account retired')), {
            once: true,
          });
        }),
    );

    const pending = flushErrorReports();
    await started.promise;
    const drain = pauseRealtimeDeliveries();

    expect(uploadSignal?.aborted).toBe(true);
    await Promise.all([pending, drain]);
    expect(count(raw)).toBe(2);
  });

  it('uploads nothing when the user turned errorReportingEnabled off', async () => {
    useFeatureSettingsStore.setState({ errorReportingEnabled: false });
    await flushErrorReports();
    expect(mockHttp.post).not.toHaveBeenCalled();
    expect(mockSink.flushToDb).not.toHaveBeenCalled();
    expect(count(raw)).toBe(0); // revocation purges reports captured under the prior choice
  });

  it('uploads nothing before consent hydration and purges a legacy queue', async () => {
    useFeatureSettingsStore.setState({ errorReportingEnabled: true, hydrated: false });

    await flushErrorReports();

    expect(mockHttp.post).not.toHaveBeenCalled();
    expect(mockSink.flushToDb).not.toHaveBeenCalled();
    expect(count(raw)).toBe(0);
  });

  it('retains the queue when consent hydration fails and remains unknown', async () => {
    const originalHydrate = useFeatureSettingsStore.getState().hydrate;
    useFeatureSettingsStore.setState({
      errorReportingEnabled: false,
      hydrated: false,
      hydrate: async () => undefined,
    });

    try {
      await flushErrorReports();
      expect(mockSink.flushToDb).not.toHaveBeenCalled();
      expect(mockHttp.post).not.toHaveBeenCalled();
      expect(count(raw)).toBe(2);
    } finally {
      useFeatureSettingsStore.setState({ hydrate: originalHydrate });
    }
  });

  it('hydrates a saved grant before a fresh headless process flushes its queue', async () => {
    await kvSet(db, ERROR_REPORTING_CONSENT_KEY, 'granted');
    useFeatureSettingsStore.setState({ errorReportingEnabled: false, hydrated: false });

    await flushErrorReports();

    expect(useFeatureSettingsStore.getState()).toMatchObject({
      errorReportingEnabled: true,
      hydrated: true,
    });
    expect(mockHttp.post).toHaveBeenCalledTimes(1);
    expect(count(raw)).toBe(0);
  });
});
