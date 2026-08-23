import type Database from 'better-sqlite3';
import {
  ERROR_REPORT_MAX_DURABLE_AGE_MS,
  ERROR_REPORT_MAX_ATTEMPTS,
  ERROR_REPORT_QUEUE_BYTE_BUDGET,
  ERROR_REPORT_SERIALIZED_ROW_OVERHEAD_BYTES,
  ERROR_REPORT_TEXT_ESCAPE_MULTIPLIER,
  ERROR_REPORT_UPLOAD_BATCH_SIZE,
  claimErrorReports,
  clearErrorReports,
  deleteErrorReports,
  errorReportBackoffMs,
  insertErrorReport,
  insertErrorReports,
  listRetryableErrorReports,
  markErrorReportsFailed,
  trimErrorReports,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

const count = (raw: Database.Database): number =>
  (raw.prepare('SELECT COUNT(*) c FROM error_reports').get() as { c: number }).c;

/** Same conservative UTF-8 + worst-case JSON-escape accounting enforced by the repository SQL. */
const serializedQueueBytes = (raw: Database.Database): number =>
  (
    raw
      .prepare(
        `SELECT COALESCE(SUM(
          ? + ? * (
            length(CAST(level AS BLOB)) +
            length(CAST(message AS BLOB)) +
            COALESCE(length(CAST(stack AS BLOB)), 0) +
            COALESCE(length(CAST(tag AS BLOB)), 0) +
            COALESCE(length(CAST(meta AS BLOB)), 0)
          )
        ), 0) AS bytes FROM error_reports`,
      )
      .get(ERROR_REPORT_SERIALIZED_ROW_OVERHEAD_BYTES, ERROR_REPORT_TEXT_ESCAPE_MULTIPLIER) as {
      bytes: number;
    }
  ).bytes;

async function seed(db: AppDatabase, n: number, createdAt = 1000): Promise<void> {
  for (let i = 0; i < n; i++) {
    await insertErrorReport(
      db,
      { level: 'error', message: `[t] e${i}`, createdAt: createdAt + i },
      createdAt + i,
    );
  }
}

async function holdRollingBackTransaction(db: AppDatabase): Promise<{
  release: () => void;
  failure: Promise<unknown>;
}> {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const neighbour = withDbTransaction(db, async () => {
    markStarted();
    await held;
    throw new Error('neighbour rollback');
  });
  const failure = neighbour.then(
    () => null,
    (error: unknown) => error,
  );
  await started;
  return { release, failure };
}

async function finishAfterQueuedObservation<T>(
  neighbour: { release: () => void; failure: Promise<unknown> },
  pending: Promise<T>[],
  observe: () => void,
): Promise<T[]> {
  let observationError: unknown;
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    observe();
  } catch (error) {
    observationError = error;
  } finally {
    neighbour.release();
  }
  const neighbourError = await neighbour.failure;
  const results = await Promise.all(pending);
  if (observationError) throw observationError;
  expect(String(neighbourError)).toContain('neighbour rollback');
  return results;
}

const nextEventLoopTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

async function waitForDriverStart(check: () => boolean, label: string): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    if (check()) return;
    await nextEventLoopTurn();
  }
  throw new Error(`${label} did not start within 20 event-loop turns`);
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
    const rows = await listRetryableErrorReports(db, () => 5000);
    expect(rows.length).toBe(3);
    expect(rows[0]!.message).toBe('[t] e0');
    expect(count(raw)).toBe(3);
  });

  it('chunks the full 200-row in-memory ring below Android SQLite variable limits', async () => {
    const { db, raw } = await createTestDb();
    const insert = jest.spyOn(db, 'insert');
    const reports = Array.from({ length: 200 }, (_, i) => ({
      level: 'error',
      message: `[batch] e${i}`,
      stack: `at f${i}`,
      tag: 'batch',
      meta: '{}',
      createdAt: 1_000 + i,
    }));

    await insertErrorReports(db, reports, 1_200);

    expect(insert).toHaveBeenCalledTimes(2);
    expect(count(raw)).toBe(200);
  });

  it('never inserts more than the item cap from one oversized caller batch', async () => {
    const { db, raw } = await createTestDb();
    const insert = jest.spyOn(db, 'insert');
    const reports = Array.from({ length: 750 }, (_, index) => ({
      level: 'error',
      message: `[oversized-batch] ${index}`,
      createdAt: 1_000 + index,
    }));

    await insertErrorReports(db, reports, 2_000);

    expect(insert).toHaveBeenCalledTimes(5);
    expect(count(raw)).toBe(500);
    expect(
      (
        raw.prepare('SELECT message FROM error_reports ORDER BY id LIMIT 1').get() as {
          message: string;
        }
      ).message,
    ).toBe('[oversized-batch] 250');
  });

  it('queues public batch and single inserts behind a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    const neighbour = await holdRollingBackTransaction(db);
    const batch = insertErrorReports(
      db,
      [
        { level: 'error', message: '[batch] one', createdAt: 1_000 },
        { level: 'error', message: '[batch] two', createdAt: 1_001 },
      ],
      2_000,
    );
    const single = insertErrorReport(
      db,
      { level: 'error', message: '[single] three', createdAt: 1_002 },
      2_000,
    );

    await finishAfterQueuedObservation(neighbour, [batch, single], () => {
      expect(count(raw)).toBe(0);
    });

    expect(count(raw)).toBe(3);
  });

  it('queues public trimming behind a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 5);
    const neighbour = await holdRollingBackTransaction(db);
    const trim = trimErrorReports(db, 3);

    await finishAfterQueuedObservation(neighbour, [trim], () => {
      expect(count(raw)).toBe(5);
    });

    expect(count(raw)).toBe(3);
  });

  it('queues public clearing behind a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 2);
    const neighbour = await holdRollingBackTransaction(db);
    const clear = clearErrorReports(db);

    await finishAfterQueuedObservation(neighbour, [clear], () => {
      expect(count(raw)).toBe(2);
    });

    expect(count(raw)).toBe(0);
  });

  it('rolls a queued purge back when its captured account authority is retired', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 2);
    const neighbour = await holdRollingBackTransaction(db);
    let current = true;
    const clear = clearErrorReports(db, () => current);

    current = false;
    neighbour.release();
    expect(String(await neighbour.failure)).toContain('neighbour rollback');
    await expect(clear).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    expect(count(raw)).toBe(2);
  });

  it('samples one live list clock after a queued neighbour and uses it for cleanup + eligibility', async () => {
    const { db, raw } = await createTestDb();
    const startedAt = 2_000_000_000_000;
    const acquiredAt = startedAt + 1_000;
    const insert = raw.prepare(
      `INSERT INTO error_reports (level, message, created_at, next_retry_at)
       VALUES ('error', ?, ?, ?)`,
    );
    insert.run(
      '[list-clock] expires while queued',
      startedAt - ERROR_REPORT_MAX_DURABLE_AGE_MS + 500,
      0,
    );
    insert.run('[list-clock] always eligible', startedAt - 200, 0);
    insert.run('[list-clock] becomes eligible', startedAt - 100, startedAt + 500);

    const neighbour = await holdRollingBackTransaction(db);
    let wallNow = startedAt;
    const clock = jest.fn(() => wallNow);
    let listSettled = false;
    const listOutcome = listRetryableErrorReports(db, clock)
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        listSettled = true;
      });

    try {
      await nextEventLoopTurn();
      expect(listSettled).toBe(false);
      expect(clock).not.toHaveBeenCalled();
      expect(raw.prepare('SELECT message FROM error_reports ORDER BY created_at').all()).toEqual([
        { message: '[list-clock] expires while queued' },
        { message: '[list-clock] always eligible' },
        { message: '[list-clock] becomes eligible' },
      ]);

      wallNow = acquiredAt;
      neighbour.release();
      expect(String(await neighbour.failure)).toContain('neighbour rollback');
      await expect(listOutcome).resolves.toMatchObject({
        kind: 'resolved',
        value: [
          { message: '[list-clock] always eligible' },
          { message: '[list-clock] becomes eligible' },
        ],
      });
      expect(clock).toHaveBeenCalledTimes(1);
      expect(raw.prepare('SELECT message FROM error_reports ORDER BY created_at').all()).toEqual([
        { message: '[list-clock] always eligible' },
        { message: '[list-clock] becomes eligible' },
      ]);

      const revokedClock = jest.fn(() => acquiredAt);
      await expect(
        listRetryableErrorReports(db, revokedClock, ERROR_REPORT_UPLOAD_BATCH_SIZE, () => false),
      ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
      expect(revokedClock).not.toHaveBeenCalled();

      await expect(listRetryableErrorReports(db, () => Number.NaN)).rejects.toMatchObject({
        name: 'RangeError',
        message: 'error-report clock must return a non-negative safe integer',
      });
      expect(raw.inTransaction).toBe(false);
      expect(raw.prepare('SELECT message FROM error_reports ORDER BY created_at').all()).toEqual([
        { message: '[list-clock] always eligible' },
        { message: '[list-clock] becomes eligible' },
      ]);
    } finally {
      neighbour.release();
      await Promise.allSettled([neighbour.failure, listOutcome]);
    }
  });

  it('awaits list cleanup and keeps the eligibility SELECT inside the same transaction', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 1);

    type DriverMethod = (query: unknown) => unknown;
    const originalRun = db.run as DriverMethod;
    const originalAll = db.all as DriverMethod;
    const realRun = db.run.bind(db) as DriverMethod;
    const realAll = db.all.bind(db) as DriverMethod;
    let trimDidStart = false;
    let selectDidStart = false;
    let releaseTrim!: () => void;
    let releaseSelect!: () => void;
    let markTrimFinished!: () => void;
    let markSelectFinished!: () => void;
    const trimHeld = new Promise<void>((resolve) => {
      releaseTrim = resolve;
    });
    const selectHeld = new Promise<void>((resolve) => {
      releaseSelect = resolve;
    });
    const trimFinished = new Promise<void>((resolve) => {
      markTrimFinished = resolve;
    });
    const selectFinished = new Promise<void>((resolve) => {
      markSelectFinished = resolve;
    });
    (db as unknown as { run: DriverMethod }).run = (query) => {
      const shape = JSON.stringify(query);
      if (!trimDidStart && shape.includes('ranked_reports') && shape.includes('retained_reports')) {
        trimDidStart = true;
        return trimHeld.then(() => realRun(query)).finally(markTrimFinished);
      }
      return realRun(query);
    };
    (db as unknown as { all: DriverMethod }).all = (query) => {
      const shape = JSON.stringify(query);
      if (
        !selectDidStart &&
        shape.includes('FROM error_reports') &&
        shape.includes('next_retry_at <=') &&
        shape.includes('ORDER BY created_at')
      ) {
        selectDidStart = true;
        return selectHeld.then(() => realAll(query)).finally(markSelectFinished);
      }
      return realAll(query);
    };

    let listSettled = false;
    const listOutcome = listRetryableErrorReports(db, () => 5_000)
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        listSettled = true;
      });
    try {
      await waitForDriverStart(() => trimDidStart, 'error-report list cleanup');
      await nextEventLoopTurn();
      expect(listSettled).toBe(false);
      expect(raw.inTransaction).toBe(true);
      expect(selectDidStart).toBe(false);

      releaseTrim();
      await trimFinished;
      await waitForDriverStart(() => selectDidStart, 'error-report eligibility SELECT');
      await nextEventLoopTurn();
      expect(listSettled).toBe(false);
      expect(raw.inTransaction).toBe(true);

      releaseSelect();
      await expect(Promise.all([listOutcome, selectFinished])).resolves.toMatchObject([
        { kind: 'resolved', value: [{ message: '[t] e0' }] },
        undefined,
      ]);
      expect(raw.inTransaction).toBe(false);
    } finally {
      releaseTrim();
      releaseSelect();
      const drains: Promise<unknown>[] = [listOutcome];
      if (trimDidStart) drains.push(trimFinished);
      if (selectDidStart) drains.push(selectFinished);
      await Promise.allSettled(drains);
      (db as unknown as { all: DriverMethod }).all = originalAll;
      (db as unknown as { run: DriverMethod }).run = originalRun;
    }
  });

  it('claim leases a row exclusively (a second claim within the lease window gets nothing)', async () => {
    const { db } = await createTestDb();
    await seed(db, 1);
    const id = (await listRetryableErrorReports(db, () => 5000))[0]!.id;
    expect(await claimErrorReports(db, [id], () => 6000)).toEqual([id]);
    expect(await claimErrorReports(db, [id], () => 6500)).toEqual([]); // still leased
  });

  it('rolls a guarded claim back when account ownership changes before COMMIT', async () => {
    const { db } = await createTestDb();
    await seed(db, 1);
    const id = (await listRetryableErrorReports(db, () => 5000))[0]!.id;
    let checks = 0;

    await expect(
      claimErrorReports(
        db,
        [id],
        () => 6000,
        () => {
          checks += 1;
          // Permit lock acquisition + BEGIN, then revoke after the UPDATE but before COMMIT.
          return checks < 3;
        },
      ),
    ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);

    expect(checks).toBe(3);
    expect(await claimErrorReports(db, [id], () => 6000)).toEqual([id]);
  });

  it('queues an unguarded claim behind a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 1);
    const id = (await listRetryableErrorReports(db, () => 5000))[0]!.id;
    const neighbour = await holdRollingBackTransaction(db);

    let acquiredAt = 6_000;
    const clock = jest.fn(() => acquiredAt);
    const claimOutcome = claimErrorReports(db, [id], clock).then(
      (value) => ({ kind: 'resolved' as const, value }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(clock).not.toHaveBeenCalled();
      expect(
        raw.prepare('SELECT next_retry_at AS nextRetryAt FROM error_reports WHERE id = ?').get(id),
      ).toEqual({ nextRetryAt: 0 });

      acquiredAt = 126_001;
      neighbour.release();
      expect(String(await neighbour.failure)).toContain('neighbour rollback');
      await expect(claimOutcome).resolves.toEqual({ kind: 'resolved', value: [id] });
      expect(clock).toHaveBeenCalledTimes(1);
      expect(
        raw.prepare('SELECT next_retry_at AS nextRetryAt FROM error_reports WHERE id = ?').get(id),
      ).toEqual({ nextRetryAt: 246_001 });
      await expect(claimErrorReports(db, [id], () => acquiredAt)).resolves.toEqual([]);
      await expect(claimErrorReports(db, [id], () => 246_000)).resolves.toEqual([]);
      await expect(claimErrorReports(db, [id], () => 246_001)).resolves.toEqual([id]);
    } finally {
      neighbour.release();
      await Promise.allSettled([neighbour.failure, claimOutcome]);
    }
  });

  it('markFailed schedules a backoff (not immediately retryable), then eligible after it elapses', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 1);
    const id = (await listRetryableErrorReports(db, () => 5000))[0]!.id;

    const revokedClock = jest.fn(() => 6_000);
    await expect(
      markErrorReportsFailed(db, [id], revokedClock, () => false),
    ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    expect(revokedClock).not.toHaveBeenCalled();
    await expect(
      markErrorReportsFailed(db, [id], () => Number.POSITIVE_INFINITY),
    ).rejects.toMatchObject({
      name: 'RangeError',
      message: 'error-report clock must return a non-negative safe integer',
    });
    expect(raw.inTransaction).toBe(false);
    expect(
      raw
        .prepare('SELECT attempts, next_retry_at AS nextRetryAt FROM error_reports WHERE id = ?')
        .get(id),
    ).toEqual({ attempts: 0, nextRetryAt: 0 });

    await markErrorReportsFailed(db, [id], () => 6000);
    expect((await listRetryableErrorReports(db, () => 6000 + 10_000)).length).toBe(0); // 30s backoff
    expect((await listRetryableErrorReports(db, () => 6000 + 31_000)).length).toBe(1);
  });

  it('guarded markFailed uses the same backoff and retirement rules in two bounded statements', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 2);
    const ids = (await listRetryableErrorReports(db, () => 5000)).map((row) => row.id);

    await markErrorReportsFailed(
      db,
      ids,
      () => 6000,
      () => true,
    );
    expect(
      raw
        .prepare('SELECT attempts, next_retry_at AS nextRetryAt FROM error_reports ORDER BY id')
        .all(),
    ).toEqual([
      { attempts: 1, nextRetryAt: 36_000 },
      { attempts: 1, nextRetryAt: 36_000 },
    ]);

    raw.prepare('UPDATE error_reports SET attempts = 4').run();
    await markErrorReportsFailed(
      db,
      ids,
      () => 7000,
      () => true,
    );
    expect(count(raw)).toBe(0);
  });

  it('counts duplicate ids once and ignores missing rows in one failed batch', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 1);
    const id = (await listRetryableErrorReports(db, () => 5000))[0]!.id;

    await markErrorReportsFailed(db, [id, id, id + 1_000], () => 6000);

    expect(
      raw
        .prepare('SELECT attempts, next_retry_at AS nextRetryAt FROM error_reports WHERE id = ?')
        .get(id),
    ).toEqual({ attempts: 1, nextRetryAt: 36_000 });
    expect(count(raw)).toBe(1);
  });

  it('handles the full 100-report uploader batch for claim, failure, and deletion', async () => {
    const { db, raw } = await createTestDb();
    await insertErrorReports(
      db,
      Array.from({ length: 100 }, (_, index) => ({
        level: 'error',
        message: `[full-batch] ${index}`,
        createdAt: 1_000 + index,
      })),
      5_000,
    );
    const ids = (await listRetryableErrorReports(db, () => 5_000)).map((row) => row.id);

    await expect(claimErrorReports(db, ids, () => 6_000)).resolves.toHaveLength(100);
    await markErrorReportsFailed(db, ids, () => 7_000);
    expect(
      raw.prepare('SELECT COUNT(*) AS count FROM error_reports WHERE attempts = 1').get(),
    ).toEqual({ count: 100 });
    await deleteErrorReports(db, ids);
    expect(count(raw)).toBe(0);
  });

  it('rejects an oversized outcome batch before any row can change', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 1);
    const id = (await listRetryableErrorReports(db, () => 5_000))[0]!.id;
    const oversizedIds = Array.from(
      { length: ERROR_REPORT_UPLOAD_BATCH_SIZE + 1 },
      (_, offset) => id + offset,
    );

    await expect(claimErrorReports(db, oversizedIds, () => 6_000)).rejects.toThrow(
      'error-report outcome batch exceeds 100 unique ids',
    );
    await expect(markErrorReportsFailed(db, oversizedIds, () => 6_000)).rejects.toThrow(
      'error-report outcome batch exceeds 100 unique ids',
    );
    await expect(deleteErrorReports(db, oversizedIds)).rejects.toThrow(
      'error-report outcome batch exceeds 100 unique ids',
    );
    expect(
      raw
        .prepare('SELECT attempts, next_retry_at AS nextRetryAt FROM error_reports WHERE id = ?')
        .get(id),
    ).toEqual({ attempts: 0, nextRetryAt: 0 });
    expect(count(raw)).toBe(1);
  });

  it('applies every persisted exponential-backoff step before the attempt cap', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 1);
    const id = (await listRetryableErrorReports(db, () => 5_000))[0]!.id;

    for (const [now, expected] of [
      [6_000, { attempts: 1, nextRetryAt: 36_000 }],
      [7_000, { attempts: 2, nextRetryAt: 67_000 }],
      [8_000, { attempts: 3, nextRetryAt: 128_000 }],
      [9_000, { attempts: 4, nextRetryAt: 249_000 }],
    ] as const) {
      await markErrorReportsFailed(db, [id], () => now);
      expect(
        raw
          .prepare('SELECT attempts, next_retry_at AS nextRetryAt FROM error_reports WHERE id = ?')
          .get(id),
      ).toEqual(expected);
    }
  });

  it('queues an unguarded failure outcome behind a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 1);
    const id = (await listRetryableErrorReports(db, () => 5000))[0]!.id;
    const neighbour = await holdRollingBackTransaction(db);

    let failedAt = 6_000;
    const clock = jest.fn(() => failedAt);
    let markSettled = false;
    const markOutcome = markErrorReportsFailed(db, [id], clock)
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        markSettled = true;
      });
    try {
      await nextEventLoopTurn();
      expect(markSettled).toBe(false);
      expect(clock).not.toHaveBeenCalled();
      expect(
        raw
          .prepare('SELECT attempts, next_retry_at AS nextRetryAt FROM error_reports WHERE id = ?')
          .get(id),
      ).toEqual({ attempts: 0, nextRetryAt: 0 });

      failedAt = 126_001;
      neighbour.release();
      expect(String(await neighbour.failure)).toContain('neighbour rollback');
      await expect(markOutcome).resolves.toEqual({ kind: 'resolved', value: undefined });
      expect(clock).toHaveBeenCalledTimes(1);
      expect(
        raw
          .prepare('SELECT attempts, next_retry_at AS nextRetryAt FROM error_reports WHERE id = ?')
          .get(id),
      ).toEqual({ attempts: 1, nextRetryAt: 156_001 });
    } finally {
      neighbour.release();
      await Promise.allSettled([neighbour.failure, markOutcome]);
    }
  });

  it('retires a row after the attempt cap (no infinite retry)', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 1);
    const id = (await listRetryableErrorReports(db, () => 5000))[0]!.id;
    let now = 6000;
    for (let i = 0; i < ERROR_REPORT_MAX_ATTEMPTS; i++) {
      await markErrorReportsFailed(db, [id], () => now);
      now += 3_700_000; // advance past the max backoff
    }
    expect(count(raw)).toBe(0);
  });

  it('delete removes uploaded rows', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 2);
    const ids = (await listRetryableErrorReports(db, () => 5000)).map((r) => r.id);
    await deleteErrorReports(db, ids);
    expect(count(raw)).toBe(0);
  });

  it('queues an unguarded success deletion behind a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 1);
    const id = (await listRetryableErrorReports(db, () => 5000))[0]!.id;
    const neighbour = await holdRollingBackTransaction(db);

    const deletion = deleteErrorReports(db, [id]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(count(raw)).toBe(1);

    neighbour.release();
    expect(String(await neighbour.failure)).toContain('neighbour rollback');
    await expect(deletion).resolves.toBeUndefined();
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

  it('retires rows older than the durable age on both write and read boundaries', async () => {
    const { db, raw } = await createTestDb();
    const now = 2_000_000_000_000;
    await insertErrorReports(
      db,
      [
        {
          level: 'error',
          message: '[age] expired during write',
          createdAt: now - ERROR_REPORT_MAX_DURABLE_AGE_MS - 1,
        },
        { level: 'error', message: '[age] current', createdAt: now },
      ],
      now,
    );
    expect(
      raw.prepare('SELECT message FROM error_reports ORDER BY id').all() as { message: string }[],
    ).toEqual([{ message: '[age] current' }]);

    // Model a legacy/pre-bound row that bypassed the current repository write path. A quiet queue
    // still cleans it before constructing an upload batch.
    raw
      .prepare('INSERT INTO error_reports (level, message, created_at) VALUES (?, ?, ?)')
      .run('error', '[age] legacy expired', now - ERROR_REPORT_MAX_DURABLE_AGE_MS - 1);
    await listRetryableErrorReports(db, () => now);
    expect(
      raw.prepare('SELECT message FROM error_reports ORDER BY id').all() as { message: string }[],
    ).toEqual([{ message: '[age] current' }]);
  });

  it('drops one report whose conservative serialized size exceeds the whole budget', async () => {
    const { db, raw } = await createTestDb();
    const oversizedMessage = 'x'.repeat(
      Math.ceil(ERROR_REPORT_QUEUE_BYTE_BUDGET / ERROR_REPORT_TEXT_ESCAPE_MULTIPLIER),
    );

    await insertErrorReport(
      db,
      {
        level: 'error',
        message: oversizedMessage,
        createdAt: 1_000,
      },
      1_000,
    );

    expect(count(raw)).toBe(0);
    expect(serializedQueueBytes(raw)).toBe(0);
  });

  it('keeps only the newest aggregate prefix that fits the serialized byte budget', async () => {
    const { db, raw } = await createTestDb();
    const reports = Array.from({ length: 20 }, (_, index) => ({
      level: 'error',
      message: `${String(index).padStart(2, '0')}:${'x'.repeat(50_000)}`,
      stack: 'at bounded',
      tag: 'bytes',
      meta: '{}',
      createdAt: 10_000 + index,
    }));

    await insertErrorReports(db, reports.slice(0, 10), 20_000);
    expect(serializedQueueBytes(raw)).toBeLessThanOrEqual(ERROR_REPORT_QUEUE_BYTE_BUDGET);
    await insertErrorReports(db, reports.slice(10), 20_000);

    const remaining = raw
      .prepare('SELECT substr(message, 1, 2) AS marker FROM error_reports ORDER BY id')
      .all() as { marker: string }[];
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.length).toBeLessThan(reports.length);
    expect(serializedQueueBytes(raw)).toBeLessThanOrEqual(ERROR_REPORT_QUEUE_BYTE_BUDGET);
    const actualSerializedBytes = Buffer.byteLength(
      JSON.stringify(
        raw
          .prepare(
            `SELECT level, message, stack, tag, meta, created_at AS timestamp
             FROM error_reports ORDER BY id`,
          )
          .all(),
      ),
      'utf8',
    );
    expect(actualSerializedBytes).toBeLessThanOrEqual(ERROR_REPORT_QUEUE_BYTE_BUDGET);
    // Trimming is deterministic: the final report survives and no older row can jump over a
    // deleted newer row to consume the remaining budget.
    expect(remaining.at(-1)?.marker).toBe('19');
    expect(remaining.map((row) => Number(row.marker))).toEqual(
      Array.from(
        { length: remaining.length },
        (_, offset) => reports.length - remaining.length + offset,
      ),
    );
  });
});
