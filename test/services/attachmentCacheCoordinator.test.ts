import {
  claimAttachmentCachePathsForRetirement,
  commitAttachmentCacheReservation,
  createAttachmentCacheReservation,
  deleteMessageLocal,
  getAttachmentCacheEntry,
  recordAttachmentCacheEntry,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  ATTACHMENT_CACHE_ACCESS_TOUCH_INTERVAL_MS,
  AttachmentCacheCoordinator,
  type AttachmentCacheNativeBoundary,
  type AttachmentCacheReservationScope,
} from '@/services/download/attachmentCacheCoordinator';
import {
  ATTACHMENT_CACHE_MAX_BYTES,
  ATTACHMENT_CACHE_MAX_FILES,
  ATTACHMENT_CACHE_MIN_FREE_BYTES,
} from '@/services/download/attachmentCacheQuotaPolicy';
import { createTestDb } from '../support/testDb';

const NOW = 2_000_000;
const OLD = NOW - 20 * 60 * 1000;
const path = (name: string): string =>
  `file:///documents/attachments/media-${name}/generation-1/media-file.jpg`;

type Outcome<T> = { kind: 'fulfilled'; value: T } | { kind: 'rejected'; error: unknown };

function observe<T>(promise: Promise<T>): { outcome: Promise<Outcome<T>>; settled(): boolean } {
  let didSettle = false;
  const outcome = promise.then<Outcome<T>, Outcome<T>>(
    (value) => ({ kind: 'fulfilled', value }),
    (error: unknown) => ({ kind: 'rejected', error }),
  );
  void outcome.then(() => {
    didSettle = true;
  });
  return { outcome, settled: () => didSettle };
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function nativeBoundary(overrides: Partial<AttachmentCacheNativeBoundary> = {}): {
  io: AttachmentCacheNativeBoundary;
  deleteFile: jest.Mock;
  getAvailableBytes: jest.Mock;
  statFile: jest.Mock;
} {
  const getAvailableBytes = jest
    .fn<Promise<number>, []>()
    .mockResolvedValue(ATTACHMENT_CACHE_MIN_FREE_BYTES + ATTACHMENT_CACHE_MAX_BYTES);
  const deleteFile = jest.fn().mockResolvedValue({ status: 'deleted' as const, bytes: 1 });
  const statFile = jest.fn().mockResolvedValue({ exists: true, bytes: 1 });
  return {
    io: { getAvailableBytes, statFile, deleteFile, ...overrides },
    deleteFile,
    getAvailableBytes,
    statFile,
  };
}

async function seedUsage(
  db: AppDatabase,
  entries: Array<{ path: string; bytes: number; lastUsedAt?: number }>,
): Promise<void> {
  for (const entry of entries) {
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, {
        path: entry.path,
        bytes: entry.bytes,
        lastUsedAt: entry.lastUsedAt ?? OLD,
      }),
    );
  }
}

async function observeDbAllTransactionState<T>(
  db: AppDatabase,
  raw: Awaited<ReturnType<typeof createTestDb>>['raw'],
  task: () => Promise<T>,
): Promise<{ value: T; transactionStates: boolean[] }> {
  const transactionStates: boolean[] = [];
  type All = (...args: Parameters<AppDatabase['all']>) => ReturnType<AppDatabase['all']>;
  const realAll = db.all.bind(db) as All;
  const allSpy = jest.spyOn(db, 'all').mockImplementation(((...args) => {
    transactionStates.push(raw.inTransaction);
    return realAll(...args);
  }) as AppDatabase['all']);
  try {
    return { value: await task(), transactionStates };
  } finally {
    allSpy.mockRestore();
  }
}

function accountScope(
  _db: AppDatabase,
  generation = 7,
): AttachmentCacheReservationScope & { revoke(): void } {
  let current = true;
  return {
    generation,
    isCurrent: () => current,
    runTracked: <T>(task: () => Promise<T>) => (current ? task() : Promise.resolve(null)),
    revoke: () => {
      current = false;
    },
  };
}

describe('attachment cache quota coordinator', () => {
  it('owns unscoped active reuse and missing repair while native stat stays outside', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary();
    let now = NOW;
    const coordinator = new AttachmentCacheCoordinator(native.io, () => now);
    const reusable = path('exact-reuse');
    const missing = path('exact-reuse-missing');
    await seedUsage(db, [
      { path: reusable, bytes: 20, lastUsedAt: NOW },
      { path: missing, bytes: 20, lastUsedAt: NOW },
    ]);
    const statTransactions: boolean[] = [];
    native.statFile.mockImplementation(async (candidate: string) => {
      statTransactions.push(raw.inTransaction);
      return candidate === missing ? { exists: false, bytes: 0 } : { exists: true, bytes: 25 };
    });

    now += ATTACHMENT_CACHE_ACCESS_TOUCH_INTERVAL_MS / 2;
    const firstReuse = await observeDbAllTransactionState(db, raw, () =>
      coordinator.reuseExisting(db, { path: reusable }),
    );
    expect(firstReuse.value).toEqual({
      status: 'hit',
    });
    expect(native.statFile).toHaveBeenCalledWith(reusable);
    // Exact bytes repair immediately, while the recent access timestamp remains coalesced.
    expect(await getAttachmentCacheEntry(db, reusable)).toMatchObject({
      state: 'active',
      bytes: 25,
      lastUsedAt: NOW,
    });

    now += ATTACHMENT_CACHE_ACCESS_TOUCH_INTERVAL_MS / 2;
    const secondReuse = await observeDbAllTransactionState(db, raw, () =>
      coordinator.reuseExisting(db, { path: reusable }),
    );
    expect(secondReuse.value).toEqual({
      status: 'hit',
    });
    expect(await getAttachmentCacheEntry(db, reusable)).toMatchObject({
      state: 'active',
      bytes: 25,
      lastUsedAt: now,
    });

    const missingReuse = await observeDbAllTransactionState(db, raw, () =>
      coordinator.reuseExisting(db, { path: missing }),
    );
    expect(missingReuse.value).toEqual({ status: 'missing' });
    expect(await getAttachmentCacheEntry(db, missing)).toBeNull();
    const transactionStates = [
      ...firstReuse.transactionStates,
      ...secondReuse.transactionStates,
      ...missingReuse.transactionStates,
    ];
    expect(transactionStates.length).toBeGreaterThan(0);
    expect(transactionStates.every(Boolean)).toBe(true);
    expect(statTransactions).toEqual([false, false, false]);
  });

  it('holds path protection across a pending native stat so retirement cannot win the reuse race', async () => {
    const { db } = await createTestDb();
    let finishStat!: (result: { exists: boolean; bytes: number }) => void;
    const statFile = jest.fn(
      () =>
        new Promise<{ exists: boolean; bytes: number }>((resolve) => {
          finishStat = resolve;
        }),
    );
    const native = nativeBoundary({ statFile });
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const reusable = path('reuse-retirement-race');
    await seedUsage(db, [{ path: reusable, bytes: 20 }]);

    const reuse = coordinator.reuseExisting(db, { path: reusable });
    expect(statFile).toHaveBeenCalledWith(reusable);
    await expect(coordinator.retireInactiveEntries(db)).resolves.toEqual({
      status: 'complete',
      attempted: 0,
      confirmed: 0,
      failed: 0,
      skipped: 1,
    });
    expect(native.deleteFile).not.toHaveBeenCalled();

    finishStat({ exists: true, bytes: 20 });
    await expect(reuse).resolves.toEqual({ status: 'hit' });
    expect(await getAttachmentCacheEntry(db, reusable)).toMatchObject({ state: 'active' });
  });

  it('owns missing-file repair after native stat and rolls every write back before a clean retry', async () => {
    const { db, raw } = await createTestDb();
    const missing = path('missing-active');
    await seedUsage(db, [{ path: missing, bytes: 20 }]);
    raw
      .prepare(`INSERT INTO attachments (guid, local_path) VALUES (?, ?), (?, ?) `)
      .run('missing-active-a', missing, 'missing-active-b', missing);
    raw.exec(`
      CREATE TRIGGER fail_missing_cache_delete
      BEFORE DELETE ON attachment_cache_entries
      WHEN OLD.path = '${missing}'
      BEGIN
        SELECT RAISE(ABORT, 'forced missing-cache delete failure');
      END
    `);

    let releaseNeighbour!: () => void;
    const neighbourGate = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    let neighbourStarted = false;
    let neighbour: ReturnType<typeof observe<void>> | undefined;
    let transactionAtStat: boolean | undefined;
    const statFile = jest
      .fn<Promise<{ exists: boolean; bytes: number }>, [string]>()
      .mockImplementationOnce(async () => {
        transactionAtStat = raw.inTransaction;
        neighbour = observe(
          withDbTransaction(db, async (_context) => {
            raw
              .prepare("INSERT INTO kv (key, value) VALUES ('cache-repair-neighbour', 'dirty')")
              .run();
            neighbourStarted = true;
            await neighbourGate;
            throw new Error('cache repair neighbour rollback');
          }),
        );
        return { exists: false, bytes: 0 };
      })
      .mockResolvedValue({ exists: false, bytes: 0 });
    const coordinator = new AttachmentCacheCoordinator(nativeBoundary({ statFile }).io, () => NOW);
    const scope = accountScope(db);
    const failedRepair = observe(coordinator.reuseExisting(db, { path: missing, scope }));

    try {
      await waitFor(() => neighbourStarted, 'missing-file repair neighbour');
      expect(transactionAtStat).toBe(false);
      expect(failedRepair.settled()).toBe(false);
      expect(await getAttachmentCacheEntry(db, missing)).toMatchObject({ state: 'active' });

      releaseNeighbour();
      await expect(neighbour?.outcome).resolves.toMatchObject({ kind: 'rejected' });
      await expect(failedRepair.outcome).resolves.toMatchObject({
        kind: 'rejected',
        error: expect.objectContaining({ message: 'forced missing-cache delete failure' }),
      });
      expect(await getAttachmentCacheEntry(db, missing)).toMatchObject({ state: 'active' });
      expect(
        raw.prepare(`SELECT guid, local_path AS localPath FROM attachments ORDER BY guid`).all(),
      ).toEqual([
        { guid: 'missing-active-a', localPath: missing },
        { guid: 'missing-active-b', localPath: missing },
      ]);
      expect(
        raw.prepare("SELECT value FROM kv WHERE key = 'cache-repair-neighbour'").get(),
      ).toBeUndefined();

      raw.exec('DROP TRIGGER fail_missing_cache_delete');
      await expect(coordinator.reuseExisting(db, { path: missing, scope })).resolves.toEqual({
        status: 'missing',
      });
      expect(await getAttachmentCacheEntry(db, missing)).toBeNull();
      expect(
        raw.prepare(`SELECT guid, local_path AS localPath FROM attachments ORDER BY guid`).all(),
      ).toEqual([
        { guid: 'missing-active-a', localPath: null },
        { guid: 'missing-active-b', localPath: null },
      ]);
    } finally {
      releaseNeighbour();
      raw.exec('DROP TRIGGER IF EXISTS fail_missing_cache_delete');
      await Promise.allSettled([neighbour?.outcome ?? Promise.resolve(), failedRepair.outcome]);
      raw.close();
    }
  });

  it('fails closed for present untracked, reserved, and retiring paths', async () => {
    const { db } = await createTestDb();
    const native = nativeBoundary({
      statFile: jest.fn().mockResolvedValue({ exists: true, bytes: 20 }),
    });
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const untracked = path('untracked-present');
    const reserved = path('reserved-present');
    const retiring = path('retiring-present');
    await withDbTransaction(db, (context) =>
      createAttachmentCacheReservation(context, { path: reserved, maxBytes: 20, createdAt: NOW }),
    );
    await seedUsage(db, [{ path: retiring, bytes: 20 }]);
    await withDbTransaction(db, async (context) => {
      const claim = await claimAttachmentCachePathsForRetirement(context, [retiring]);
      if (claim.status !== 'claimed') throw new Error(`test setup claim refused: ${claim.reason}`);
    });

    await expect(coordinator.reuseExisting(db, { path: untracked })).resolves.toEqual({
      status: 'busy',
    });
    await expect(coordinator.reuseExisting(db, { path: reserved })).resolves.toEqual({
      status: 'busy',
    });
    await expect(coordinator.reuseExisting(db, { path: retiring })).resolves.toEqual({
      status: 'busy',
    });
    expect(await getAttachmentCacheEntry(db, untracked)).toBeNull();
    expect(await getAttachmentCacheEntry(db, reserved)).toMatchObject({ state: 'reserved' });
    expect(await getAttachmentCacheEntry(db, retiring)).toMatchObject({ state: 'retiring' });
  });

  it('rechecks active ownership after stat and refuses when retirement won meanwhile', async () => {
    const { db } = await createTestDb();
    const raced = path('stat-state-race');
    await seedUsage(db, [{ path: raced, bytes: 20 }]);
    const statFile = jest.fn(async () => {
      await withDbTransaction(db, async (context) => {
        const claim = await claimAttachmentCachePathsForRetirement(context, [raced]);
        if (claim.status !== 'claimed')
          throw new Error(`test setup claim refused: ${claim.reason}`);
      });
      return { exists: true, bytes: 20 };
    });
    const coordinator = new AttachmentCacheCoordinator(nativeBoundary({ statFile }).io, () => NOW);

    await expect(coordinator.reuseExisting(db, { path: raced })).resolves.toEqual({
      status: 'busy',
    });
    expect(await getAttachmentCacheEntry(db, raced)).toMatchObject({ state: 'retiring' });
  });

  it('recovers a durable reserved row with a fresh coordinator after a process crash', async () => {
    const { db } = await createTestDb();
    const native = nativeBoundary();
    const abandoned = path('crash-reserved');
    await withDbTransaction(db, (context) =>
      createAttachmentCacheReservation(context, {
        path: abandoned,
        maxBytes: 40,
        createdAt: OLD,
      }),
    );

    // No in-memory reservation owner survives this simulated restart. The encrypted row is the
    // authority that lets a new process find and exactly delete a possibly promoted final file.
    const restarted = new AttachmentCacheCoordinator(native.io, () => NOW);
    await expect(restarted.drainDueRetirements(db)).resolves.toEqual({
      status: 'complete',
      attempted: 1,
      confirmed: 1,
      failed: 0,
      skipped: 0,
    });
    expect(native.deleteFile).toHaveBeenCalledTimes(1);
    expect(native.deleteFile).toHaveBeenCalledWith(abandoned);
    expect(await getAttachmentCacheEntry(db, abandoned)).toBeNull();
  });

  it('clamps an oversized due-retirement drain to 100 rows', async () => {
    const { db, raw } = await createTestDb();
    const duePaths = Array.from({ length: 101 }, (_, index) =>
      path(`bounded-drain-${String(index).padStart(3, '0')}`),
    );
    const deleteTransactions: boolean[] = [];
    const deleteFile = jest.fn(async () => {
      deleteTransactions.push(raw.inTransaction);
      return { status: 'deleted' as const, bytes: 1 };
    });
    const coordinator = new AttachmentCacheCoordinator(
      nativeBoundary({ deleteFile }).io,
      () => NOW,
    );
    const remainingDueRows = (): number =>
      (
        raw
          .prepare(
            "SELECT COUNT(*) AS count FROM attachment_cache_entries WHERE state IN ('reserved', 'retiring')",
          )
          .get() as { count: number }
      ).count;

    try {
      for (const duePath of duePaths) {
        expect(
          await withDbTransaction(db, (context) =>
            createAttachmentCacheReservation(context, {
              path: duePath,
              maxBytes: 1,
              createdAt: OLD,
            }),
          ),
        ).toBe(true);
      }

      await expect(
        coordinator.drainDueRetirements(db, { limit: Number.MAX_SAFE_INTEGER }),
      ).resolves.toEqual({
        status: 'complete',
        attempted: 100,
        confirmed: 100,
        failed: 0,
        skipped: 0,
      });
      expect(remainingDueRows()).toBe(1);

      await expect(coordinator.drainDueRetirements(db)).resolves.toEqual({
        status: 'complete',
        attempted: 1,
        confirmed: 1,
        failed: 0,
        skipped: 0,
      });
      expect(remainingDueRows()).toBe(0);
      expect(deleteFile).toHaveBeenCalledTimes(101);
      expect(deleteTransactions).toEqual(Array(101).fill(false));
    } finally {
      raw.close();
    }
  });

  it('rechecks an unscoped due snapshot in a second direct transaction before native delete', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const promoted = path('snapshot-promoted');
    await withDbTransaction(db, (context) =>
      createAttachmentCacheReservation(context, {
        path: promoted,
        maxBytes: 40,
        createdAt: OLD,
      }),
    );

    const transactionAtDueList: boolean[] = [];
    const transactionAtRecheck: boolean[] = [];
    let promotion: ReturnType<typeof observe<boolean>> | undefined;
    let observingCoordinator = true;
    type All = (...args: Parameters<AppDatabase['all']>) => ReturnType<AppDatabase['all']>;
    const realAll = db.all.bind(db) as All;
    const allSpy = jest.spyOn(db, 'all').mockImplementation(((...args) => {
      const shape = JSON.stringify(args[0]).replace(/\s+/g, ' ').toLowerCase();
      if (
        observingCoordinator &&
        shape.includes('order by next_retry_at') &&
        shape.includes('attachment_cache_entries')
      ) {
        transactionAtDueList.push(raw.inTransaction);
        // Claim the next queue slot synchronously, but do not await it from inside due-list owner A.
        // Promotion B therefore runs after A releases and before recheck owner C can begin.
        promotion = observe(
          withDbTransaction(db, (context) =>
            commitAttachmentCacheReservation(context, {
              path: promoted,
              bytes: 25,
              lastUsedAt: NOW,
            }),
          ),
        );
      } else if (
        observingCoordinator &&
        shape.includes('from attachment_cache_entries') &&
        shape.includes('where path') &&
        shape.includes('limit 1')
      ) {
        transactionAtRecheck.push(raw.inTransaction);
      }
      return realAll(...args);
    }) as AppDatabase['all']);

    try {
      await expect(coordinator.drainDueRetirements(db)).resolves.toEqual({
        status: 'complete',
        attempted: 0,
        confirmed: 0,
        failed: 0,
        skipped: 1,
      });
      observingCoordinator = false;
      await expect(promotion?.outcome).resolves.toEqual({ kind: 'fulfilled', value: true });
      expect(transactionAtDueList).toEqual([true]);
      expect(transactionAtRecheck).toEqual([true]);
      expect(native.deleteFile).not.toHaveBeenCalled();
      expect(await getAttachmentCacheEntry(db, promoted)).toMatchObject({
        state: 'active',
        bytes: 25,
        lastUsedAt: NOW,
      });
    } finally {
      allSpy.mockRestore();
      await Promise.allSettled([promotion?.outcome ?? Promise.resolve()]);
      raw.close();
    }
  });

  it('tracks due-list and post-gate recheck in separate source-owned transactions', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const promoted = path('tracked-snapshot-promoted');
    await withDbTransaction(db, (context) =>
      createAttachmentCacheReservation(context, {
        path: promoted,
        maxBytes: 40,
        createdAt: OLD,
      }),
    );

    const queryOwners: string[] = [];
    let activeOwner: string | undefined;
    type All = (...args: Parameters<AppDatabase['all']>) => ReturnType<AppDatabase['all']>;
    const realAll = db.all.bind(db) as All;
    const allSpy = jest.spyOn(db, 'all').mockImplementation(((...args) => {
      if (activeOwner) {
        expect(raw.inTransaction).toBe(true);
        queryOwners.push(activeOwner);
      }
      return realAll(...args);
    }) as AppDatabase['all']);
    let trackedCalls = 0;
    const scope: AttachmentCacheReservationScope = {
      generation: 9,
      isCurrent: () => true,
      runTracked: async <T>(task: () => Promise<T>): Promise<T | null> => {
        trackedCalls += 1;
        activeOwner = trackedCalls === 1 ? 'due-list' : 'post-gate recheck';
        let result: T;
        try {
          result = await task();
        } finally {
          activeOwner = undefined;
        }
        if (trackedCalls === 1) {
          // Promote after the due-list owner commits but before the coordinator obtains the gate.
          expect(
            await withDbTransaction(db, (context) =>
              commitAttachmentCacheReservation(context, {
                path: promoted,
                bytes: 25,
                lastUsedAt: NOW,
              }),
            ),
          ).toBe(true);
        }
        return result;
      },
    };

    try {
      await expect(coordinator.drainDueRetirements(db, { scope })).resolves.toEqual({
        status: 'complete',
        attempted: 0,
        confirmed: 0,
        failed: 0,
        skipped: 1,
      });
      expect(trackedCalls).toBe(2);
      expect(queryOwners).toEqual(['due-list', 'post-gate recheck']);
      expect(native.deleteFile).not.toHaveBeenCalled();
      expect(await getAttachmentCacheEntry(db, promoted)).toMatchObject({
        state: 'active',
        bytes: 25,
        lastUsedAt: NOW,
      });
    } finally {
      allSpy.mockRestore();
      raw.close();
    }
  });

  it('keeps a shared path while one live reference remains, then deletes it after the final tombstone', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary();
    const deleteTransactions: boolean[] = [];
    native.deleteFile.mockImplementation(async () => {
      deleteTransactions.push(raw.inTransaction);
      return { status: 'deleted', bytes: 30 };
    });
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const shared = path('shared-final-reference');
    await seedUsage(db, [{ path: shared, bytes: 30 }]);
    raw.prepare(`INSERT INTO chats (guid) VALUES ('shared-chat')`).run();
    const chat = raw.prepare(`SELECT id FROM chats WHERE guid = 'shared-chat'`).get() as {
      id: number;
    };
    raw
      .prepare(
        `INSERT INTO messages (guid, chat_id, date_created)
         VALUES ('shared-first', ?, 1), ('shared-final', ?, 2)`,
      )
      .run(chat.id, chat.id);
    const first = raw.prepare(`SELECT id FROM messages WHERE guid = 'shared-first'`).get() as {
      id: number;
    };
    const final = raw.prepare(`SELECT id FROM messages WHERE guid = 'shared-final'`).get() as {
      id: number;
    };
    raw
      .prepare(
        `INSERT INTO attachments (guid, message_id, local_path)
         VALUES ('shared-first-att', ?, ?), ('shared-final-att', ?, ?)`,
      )
      .run(first.id, shared, final.id, shared);

    await deleteMessageLocal(db, 'shared-first', NOW - 2);
    const firstRetirement = await observeDbAllTransactionState(db, raw, () =>
      coordinator.retireInactiveEntries(db),
    );
    expect(firstRetirement.value).toEqual({
      status: 'complete',
      attempted: 0,
      confirmed: 0,
      failed: 0,
      skipped: 0,
    });
    expect(native.deleteFile).not.toHaveBeenCalled();
    expect(await getAttachmentCacheEntry(db, shared)).toMatchObject({ state: 'active' });
    expect(
      raw.prepare(`SELECT COUNT(*) AS count FROM attachments WHERE local_path = ?`).get(shared),
    ).toEqual({ count: 2 });

    await deleteMessageLocal(db, 'shared-final', NOW - 1);
    const finalRetirement = await observeDbAllTransactionState(db, raw, () =>
      coordinator.retireInactiveEntries(db),
    );
    expect(finalRetirement.value).toEqual({
      status: 'complete',
      attempted: 1,
      confirmed: 1,
      failed: 0,
      skipped: 0,
    });
    expect(native.deleteFile).toHaveBeenCalledTimes(1);
    expect(native.deleteFile).toHaveBeenCalledWith(shared);
    expect(await getAttachmentCacheEntry(db, shared)).toBeNull();
    expect(
      raw.prepare(`SELECT COUNT(*) AS count FROM attachments WHERE local_path = ?`).get(shared),
    ).toEqual({ count: 0 });
    const transactionStates = [
      ...firstRetirement.transactionStates,
      ...finalRetirement.transactionStates,
    ];
    expect(transactionStates.length).toBeGreaterThan(0);
    expect(transactionStates.every(Boolean)).toBe(true);
    expect(deleteTransactions).toEqual([false]);
  });

  it('skips a pinned inactive path until its last protection is released', async () => {
    const { db } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const inactive = path('pinned-inactive');
    await seedUsage(db, [{ path: inactive, bytes: 20 }]);
    const pin = coordinator.protect(inactive)!;

    await expect(coordinator.retireInactiveEntries(db)).resolves.toEqual({
      status: 'complete',
      attempted: 0,
      confirmed: 0,
      failed: 0,
      skipped: 1,
    });
    expect(native.deleteFile).not.toHaveBeenCalled();
    expect(await getAttachmentCacheEntry(db, inactive)).toMatchObject({ state: 'active' });

    pin.release();
    await expect(coordinator.retireInactiveEntries(db)).resolves.toEqual({
      status: 'complete',
      attempted: 1,
      confirmed: 1,
      failed: 0,
      skipped: 0,
    });
    expect(native.deleteFile).toHaveBeenCalledTimes(1);
    expect(native.deleteFile).toHaveBeenCalledWith(inactive);
    expect(await getAttachmentCacheEntry(db, inactive)).toBeNull();
  });

  it('tracks one atomic inactive claim, skips an outgoing path, then deletes outside the mutex', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const queued = path('inactive-outgoing-protected');
    const safe = path('inactive-safe-sibling');
    await seedUsage(db, [
      { path: queued, bytes: 10, lastUsedAt: OLD },
      { path: safe, bytes: 10, lastUsedAt: OLD + 1 },
    ]);
    raw
      .prepare(
        `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
         VALUES ('temp-inactive-protected', 'chat', 'attachment', ?)`,
      )
      .run(JSON.stringify({ attachmentGuid: 'inactive-protected-att', localPath: queued }));
    raw.prepare(`INSERT INTO chats (guid) VALUES ('inactive-safe-chat')`).run();
    const chat = raw.prepare(`SELECT id FROM chats WHERE guid = 'inactive-safe-chat'`).get() as {
      id: number;
    };
    raw
      .prepare(
        `INSERT INTO messages (guid, chat_id, date_created, date_deleted)
         VALUES ('inactive-safe-a', ?, 1, 2), ('inactive-safe-b', ?, 1, 2)`,
      )
      .run(chat.id, chat.id);
    const messageIds = raw
      .prepare(`SELECT id FROM messages WHERE guid LIKE 'inactive-safe-%' ORDER BY guid`)
      .all() as Array<{ id: number }>;
    raw
      .prepare(
        `INSERT INTO attachments (guid, message_id, local_path)
         VALUES ('inactive-safe-att-a', ?, ?), ('inactive-safe-att-b', ?, ?)`,
      )
      .run(messageIds[0]?.id, safe, messageIds[1]?.id, safe);
    let trackedCalls = 0;
    const scope: AttachmentCacheReservationScope = {
      generation: 11,
      isCurrent: () => true,
      runTracked: async <T>(task: () => Promise<T>): Promise<T> => {
        trackedCalls += 1;
        return task();
      },
    };
    type All = (...args: Parameters<AppDatabase['all']>) => ReturnType<AppDatabase['all']>;
    const realAll = db.all.bind(db) as All;
    const transactionAtInactiveList: boolean[] = [];
    const allSpy = jest.spyOn(db, 'all').mockImplementation(((...args) => {
      const shape = JSON.stringify(args[0]).replace(/\s+/g, ' ').toLowerCase();
      if (
        shape.includes('select e.path') &&
        shape.includes('attachment_cache_entries e') &&
        shape.includes('order by e.last_used_at')
      ) {
        transactionAtInactiveList.push(raw.inTransaction);
      }
      return realAll(...args);
    }) as AppDatabase['all']);
    native.deleteFile.mockImplementationOnce(async (candidate: string) => {
      expect(candidate).toBe(safe);
      expect(raw.inTransaction).toBe(false);
      expect(await getAttachmentCacheEntry(db, safe)).toMatchObject({ state: 'retiring' });
      expect(
        raw
          .prepare(
            `SELECT guid, local_path AS localPath
             FROM attachments WHERE guid LIKE 'inactive-safe-att-%' ORDER BY guid`,
          )
          .all(),
      ).toEqual([
        { guid: 'inactive-safe-att-a', localPath: null },
        { guid: 'inactive-safe-att-b', localPath: null },
      ]);
      expect(await getAttachmentCacheEntry(db, queued)).toMatchObject({ state: 'active' });
      return { status: 'deleted', bytes: 10 };
    });

    try {
      await expect(coordinator.retireInactiveEntries(db, { scope })).resolves.toEqual({
        status: 'complete',
        attempted: 1,
        confirmed: 1,
        failed: 0,
        skipped: 1,
      });
      expect(transactionAtInactiveList).toEqual([true]);
      expect(native.deleteFile).toHaveBeenCalledTimes(1);
      expect(native.deleteFile).toHaveBeenCalledWith(safe);
      expect(await getAttachmentCacheEntry(db, queued)).toMatchObject({ state: 'active' });
      expect(await getAttachmentCacheEntry(db, safe)).toBeNull();
      expect(trackedCalls).toBe(2); // claim plus confirmed-delete settlement
    } finally {
      allSpy.mockRestore();
    }
  });

  it('never claims more than 100 inactive paths through the tracked owner', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const candidates = Array.from({ length: 101 }, (_, index) => ({
      path: path(`inactive-batch-${String(index).padStart(3, '0')}`),
      bytes: 1,
      lastUsedAt: OLD + index,
    }));
    await seedUsage(db, candidates);
    const transactionAtDelete: boolean[] = [];
    native.deleteFile.mockImplementation(async () => {
      transactionAtDelete.push(raw.inTransaction);
      return { status: 'deleted', bytes: 1 };
    });
    const scope: AttachmentCacheReservationScope = {
      generation: 13,
      isCurrent: () => true,
      runTracked: <T>(task: () => Promise<T>) => task(),
    };

    try {
      await expect(coordinator.retireInactiveEntries(db, { scope })).resolves.toEqual({
        status: 'complete',
        attempted: 100,
        confirmed: 100,
        failed: 0,
        skipped: 0,
      });
      expect(native.deleteFile).toHaveBeenCalledTimes(100);
      expect(
        raw
          .prepare(
            `SELECT path, state FROM attachment_cache_entries
             WHERE state = 'active' ORDER BY path`,
          )
          .all(),
      ).toEqual([{ path: candidates[100]?.path, state: 'active' }]);

      await expect(coordinator.retireInactiveEntries(db, { scope })).resolves.toEqual({
        status: 'complete',
        attempted: 1,
        confirmed: 1,
        failed: 0,
        skipped: 0,
      });
      expect(native.deleteFile).toHaveBeenCalledTimes(101);
      expect(transactionAtDelete).toEqual(Array.from({ length: 101 }, () => false));
      expect(raw.prepare('SELECT COUNT(*) AS count FROM attachment_cache_entries').get()).toEqual({
        count: 0,
      });
    } finally {
      raw.close();
    }
  });

  it('rolls back an inactive claim whose final reference clear fails, then retries cleanly', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const inactive = path('inactive-claim-rollback');
    await seedUsage(db, [{ path: inactive, bytes: 20 }]);
    raw.prepare(`INSERT INTO chats (guid) VALUES ('inactive-rollback-chat')`).run();
    const chat = raw
      .prepare(`SELECT id FROM chats WHERE guid = 'inactive-rollback-chat'`)
      .get() as {
      id: number;
    };
    raw
      .prepare(
        `INSERT INTO messages (guid, chat_id, date_created, date_deleted)
         VALUES ('inactive-rollback-a', ?, 1, 2), ('inactive-rollback-b', ?, 1, 2)`,
      )
      .run(chat.id, chat.id);
    const messageIds = raw
      .prepare(`SELECT id FROM messages WHERE guid LIKE 'inactive-rollback-%' ORDER BY guid`)
      .all() as Array<{ id: number }>;
    raw
      .prepare(
        `INSERT INTO attachments (guid, message_id, local_path)
         VALUES ('inactive-rollback-att-a', ?, ?), ('inactive-rollback-att-b', ?, ?)`,
      )
      .run(messageIds[0]?.id, inactive, messageIds[1]?.id, inactive);
    raw.exec(`
      CREATE TRIGGER fail_inactive_cache_reference_clear
      BEFORE UPDATE OF local_path ON attachments
      WHEN OLD.local_path = '${inactive}'
      BEGIN
        SELECT RAISE(ABORT, 'forced inactive reference clear failure');
      END
    `);
    const trackedScope = (): AttachmentCacheReservationScope => ({
      generation: 12,
      isCurrent: () => true,
      runTracked: <T>(task: () => Promise<T>) => task(),
    });

    try {
      const failure = await coordinator.retireInactiveEntries(db, { scope: trackedScope() }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({
        name: 'SqliteError',
        code: 'SQLITE_CONSTRAINT_TRIGGER',
        message: 'forced inactive reference clear failure',
      });
      expect(native.deleteFile).not.toHaveBeenCalled();
      expect(await getAttachmentCacheEntry(db, inactive)).toMatchObject({ state: 'active' });
      expect(
        raw
          .prepare(
            `SELECT guid, local_path AS localPath
             FROM attachments WHERE guid LIKE 'inactive-rollback-att-%' ORDER BY guid`,
          )
          .all(),
      ).toEqual([
        { guid: 'inactive-rollback-att-a', localPath: inactive },
        { guid: 'inactive-rollback-att-b', localPath: inactive },
      ]);
      const pendingProbe = coordinator.protect(inactive);
      expect(pendingProbe).not.toBeNull();
      pendingProbe?.release();

      raw.exec('DROP TRIGGER fail_inactive_cache_reference_clear');
      await expect(
        coordinator.retireInactiveEntries(db, { scope: trackedScope() }),
      ).resolves.toEqual({
        status: 'complete',
        attempted: 1,
        confirmed: 1,
        failed: 0,
        skipped: 0,
      });
      expect(native.deleteFile).toHaveBeenCalledWith(inactive);
      expect(await getAttachmentCacheEntry(db, inactive)).toBeNull();
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS fail_inactive_cache_reference_clear');
    }
  });

  it('charges concurrent reservations and rejects over-admission when no LRU file is disposable', async () => {
    const { db } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const protectedPath = path('protected');
    await seedUsage(db, [{ path: protectedPath, bytes: ATTACHMENT_CACHE_MAX_BYTES - 15 }]);
    const pin = coordinator.protect(protectedPath)!;

    const [first, second] = await Promise.all([
      coordinator.reserve(db, { path: path('first'), maxBytes: 10 }),
      coordinator.reserve(db, { path: path('second'), maxBytes: 10 }),
    ]);

    expect(first.status).toBe('reserved');
    expect(second).toEqual({ status: 'storage' });
    expect(native.deleteFile).not.toHaveBeenCalled();
    if (first.status === 'reserved') await first.reservation.release();
    pin.release();
  });

  it('uses identity-checked releases so an old reservation cannot clear a newer owner', async () => {
    const { db } = await createTestDb();
    const coordinator = new AttachmentCacheCoordinator(nativeBoundary().io, () => NOW);
    const target = path('aba');
    const first = await coordinator.reserve(db, { path: target, maxBytes: 10 });
    expect(first.status).toBe('reserved');
    if (first.status !== 'reserved') throw new Error('expected first reservation');
    await first.reservation.release();

    const second = await coordinator.reserve(db, { path: target, maxBytes: 10 });
    expect(second.status).toBe('reserved');
    await first.reservation.release();
    expect(first.reservation.beginProtectionHandoff()).toBe(false);
    expect(first.reservation.rollbackProtectionHandoff()).toBe(false);
    expect(coordinator.protect(target)).toBeNull();
    expect(await coordinator.reserve(db, { path: target, maxBytes: 10 })).toEqual({
      status: 'busy',
    });
    if (second.status === 'reserved') await second.reservation.release();
  });

  it('refuses pins before promotion and lets the exact reservation hand off after promotion', async () => {
    const { db } = await createTestDb();
    const coordinator = new AttachmentCacheCoordinator(nativeBoundary().io, () => NOW);
    const target = path('promotion-handoff');
    const admission = await coordinator.reserve(db, { path: target, maxBytes: 20 });
    expect(admission.status).toBe('reserved');
    if (admission.status !== 'reserved') throw new Error('expected reservation');

    expect(coordinator.protect(target)).toBeNull();
    let pin: ReturnType<AttachmentCacheCoordinator['protect']> = null;
    await withDbTransaction(db, async (context) => {
      expect(
        await commitAttachmentCacheReservation(context, {
          path: target,
          bytes: 10,
          lastUsedAt: NOW,
        }),
      ).toBe(true);
      expect(admission.reservation.beginProtectionHandoff()).toBe(true);
      pin = coordinator.protect(target);
      expect(pin).not.toBeNull();
    });

    expect(pin).not.toBeNull();
    (pin as { release(): void } | null)?.release();
    await expect(coordinator.reserve(db, { path: target, maxBytes: 20 })).resolves.toEqual({
      status: 'busy',
    });
    await expect(coordinator.retireInactiveEntries(db)).resolves.toEqual({
      status: 'complete',
      attempted: 0,
      confirmed: 0,
      failed: 0,
      skipped: 1,
    });
    await admission.reservation.release();
  });

  it('can close a promoted handoff safely when its surrounding transaction rolls back', async () => {
    const { db } = await createTestDb();
    const coordinator = new AttachmentCacheCoordinator(nativeBoundary().io, () => NOW);
    const target = path('promotion-rollback');
    const admission = await coordinator.reserve(db, { path: target, maxBytes: 20 });
    expect(admission.status).toBe('reserved');
    if (admission.status !== 'reserved') throw new Error('expected reservation');

    await expect(
      withDbTransaction(db, async (context) => {
        expect(
          await commitAttachmentCacheReservation(context, {
            path: target,
            bytes: 10,
            lastUsedAt: NOW,
          }),
        ).toBe(true);
        expect(admission.reservation.beginProtectionHandoff()).toBe(true);
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    expect(await getAttachmentCacheEntry(db, target)).toMatchObject({ state: 'reserved' });
    expect(admission.reservation.rollbackProtectionHandoff()).toBe(true);
    expect(coordinator.protect(target)).toBeNull();
    await admission.reservation.release();
    expect(await getAttachmentCacheEntry(db, target)).toBeNull();
  });

  it('atomically clears duplicate references, deletes one LRU file, confirms it, and replans', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const old = path('old');
    const protectedPath = path('large');
    await seedUsage(db, [
      { path: old, bytes: 20, lastUsedAt: OLD },
      { path: protectedPath, bytes: ATTACHMENT_CACHE_MAX_BYTES - 25, lastUsedAt: OLD + 1 },
    ]);
    raw
      .prepare(`INSERT INTO attachments (guid, local_path) VALUES ('a', ?), ('b', ?) `)
      .run(old, old);
    const pin = coordinator.protect(protectedPath)!;
    const trackedClaims: number[] = [];
    const scope: AttachmentCacheReservationScope = {
      generation: 7,
      isCurrent: () => true,
      runTracked: async <T>(task: () => Promise<T>): Promise<T> => {
        const result = await task();
        const inspected = result as { status?: unknown; paths?: unknown };
        if (inspected.status === 'claimed' && Array.isArray(inspected.paths)) {
          trackedClaims.push(inspected.paths.length);
        }
        return result;
      },
    };
    native.deleteFile.mockImplementationOnce(async () => {
      expect(raw.inTransaction).toBe(false);
      expect(await getAttachmentCacheEntry(db, old)).toMatchObject({ state: 'retiring' });
      expect(
        raw.prepare(`SELECT guid, local_path AS localPath FROM attachments ORDER BY guid`).all(),
      ).toEqual([
        { guid: 'a', localPath: null },
        { guid: 'b', localPath: null },
      ]);
      return { status: 'deleted', bytes: 20 };
    });

    const admission = await coordinator.reserve(db, {
      path: path('new'),
      maxBytes: 10,
      scope,
    });

    expect(admission.status).toBe('reserved');
    expect(trackedClaims).toEqual([1]);
    expect(native.deleteFile).toHaveBeenCalledWith(old);
    expect(await getAttachmentCacheEntry(db, old)).toBeNull();
    expect(
      raw.prepare(`SELECT guid, local_path AS localPath FROM attachments ORDER BY guid`).all(),
    ).toEqual([
      { guid: 'a', localPath: null },
      { guid: 'b', localPath: null },
    ]);
    if (admission.status === 'reserved') await admission.reservation.release();
    pin.release();
  });

  it('rolls back a failed admission claim and releases its pending path protection', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const old = path('claim-rollback');
    const protectedPath = path('claim-rollback-large');
    const replacement = path('claim-rollback-new');
    await seedUsage(db, [
      { path: old, bytes: 20, lastUsedAt: OLD },
      { path: protectedPath, bytes: ATTACHMENT_CACHE_MAX_BYTES - 25, lastUsedAt: OLD + 1 },
    ]);
    raw
      .prepare(
        `INSERT INTO attachments (guid, local_path) VALUES ('rollback-a', ?), ('rollback-b', ?) `,
      )
      .run(old, old);
    raw.exec(`
      CREATE TRIGGER fail_attachment_cache_claim_reference_clear
      BEFORE UPDATE OF local_path ON attachments
      WHEN OLD.local_path IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'forced claim reference clear failure');
      END
    `);
    const largePin = coordinator.protect(protectedPath)!;

    try {
      await expect(
        coordinator.reserve(db, {
          path: replacement,
          maxBytes: 10,
          scope: accountScope(db),
        }),
      ).rejects.toMatchObject({
        name: 'SqliteError',
        code: 'SQLITE_CONSTRAINT_TRIGGER',
        message: 'forced claim reference clear failure',
      });

      expect(native.deleteFile).not.toHaveBeenCalled();
      expect(await getAttachmentCacheEntry(db, old)).toMatchObject({ state: 'active' });
      expect(await getAttachmentCacheEntry(db, replacement)).toBeNull();
      expect(
        raw.prepare(`SELECT guid, local_path AS localPath FROM attachments ORDER BY guid`).all(),
      ).toEqual([
        { guid: 'rollback-a', localPath: old },
        { guid: 'rollback-b', localPath: old },
      ]);

      raw.exec(`DROP TRIGGER fail_attachment_cache_claim_reference_clear`);
      const pendingProbe = coordinator.protect(old);
      expect(pendingProbe).not.toBeNull();
      pendingProbe?.release();

      const retried = await coordinator.reserve(db, {
        path: replacement,
        maxBytes: 10,
        scope: accountScope(db, 8),
      });
      expect(retried.status).toBe('reserved');
      expect(native.deleteFile).toHaveBeenCalledWith(old);
      expect(await getAttachmentCacheEntry(db, old)).toBeNull();
      if (retried.status === 'reserved') await retried.reservation.release();
    } finally {
      raw.exec(`DROP TRIGGER IF EXISTS fail_attachment_cache_claim_reference_clear`);
      largePin.release();
    }
  });

  it('keeps a failed delete charged and persists its retry instead of admitting from predicted space', async () => {
    const { db } = await createTestDb();
    const native = nativeBoundary();
    native.deleteFile.mockRejectedValueOnce(new Error('disk busy'));
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const old = path('failed-delete');
    const protectedPath = path('failed-large');
    await seedUsage(db, [
      { path: old, bytes: 20 },
      { path: protectedPath, bytes: ATTACHMENT_CACHE_MAX_BYTES - 25 },
    ]);
    const pin = coordinator.protect(protectedPath)!;

    await expect(coordinator.reserve(db, { path: path('blocked'), maxBytes: 10 })).resolves.toEqual(
      { status: 'storage' },
    );
    expect(await getAttachmentCacheEntry(db, old)).toMatchObject({
      state: 'retiring',
      attempts: 1,
      nextRetryAt: NOW + 5_000,
    });
    pin.release();
  });

  it('treats a native missing result as confirmed absence', async () => {
    const { db } = await createTestDb();
    const native = nativeBoundary();
    native.deleteFile.mockResolvedValueOnce({ status: 'missing', bytes: 0 });
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const old = path('already-missing');
    const protectedPath = path('missing-large');
    await seedUsage(db, [
      { path: old, bytes: 20 },
      { path: protectedPath, bytes: ATTACHMENT_CACHE_MAX_BYTES - 25 },
    ]);
    const pin = coordinator.protect(protectedPath)!;

    const admission = await coordinator.reserve(db, { path: path('replacement'), maxBytes: 10 });

    expect(admission.status).toBe('reserved');
    expect(await getAttachmentCacheEntry(db, old)).toBeNull();
    if (admission.status === 'reserved') await admission.reservation.release();
    pin.release();
  });

  it('skips an outgoing-protected LRU path and retires the next safe candidate', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary();
    const nativeTransactions: boolean[] = [];
    native.getAvailableBytes.mockImplementation(async () => {
      nativeTransactions.push(raw.inTransaction);
      return ATTACHMENT_CACHE_MIN_FREE_BYTES + ATTACHMENT_CACHE_MAX_BYTES;
    });
    native.deleteFile.mockImplementation(async () => {
      nativeTransactions.push(raw.inTransaction);
      return { status: 'deleted', bytes: 10 };
    });
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const queued = path('queued');
    const safe = path('safe');
    const protectedPath = path('queue-large');
    await seedUsage(db, [
      { path: queued, bytes: 10, lastUsedAt: OLD },
      { path: safe, bytes: 10, lastUsedAt: OLD + 1 },
      { path: protectedPath, bytes: ATTACHMENT_CACHE_MAX_BYTES - 25, lastUsedAt: OLD + 2 },
    ]);
    raw
      .prepare(
        `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
         VALUES ('temp-queued', 'chat', 'attachment', ?)`,
      )
      .run(JSON.stringify({ attachmentGuid: 'queued-att', localPath: queued }));
    const pin = coordinator.protect(protectedPath)!;

    const observed = await observeDbAllTransactionState(db, raw, () =>
      coordinator.reserve(db, { path: path('new-safe'), maxBytes: 10 }),
    );
    const admission = observed.value;

    expect(admission.status).toBe('reserved');
    expect(observed.transactionStates.length).toBeGreaterThan(0);
    expect(observed.transactionStates.every(Boolean)).toBe(true);
    expect(nativeTransactions.length).toBeGreaterThan(0);
    expect(nativeTransactions.every((state) => !state)).toBe(true);
    expect(native.deleteFile).toHaveBeenCalledTimes(1);
    expect(native.deleteFile).toHaveBeenCalledWith(safe);
    expect(await getAttachmentCacheEntry(db, queued)).toMatchObject({ state: 'active' });
    if (admission.status === 'reserved') await admission.reservation.release();
    pin.release();
  });

  it('honours synchronous path pins and admits after the pin is released', async () => {
    const { db } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const old = path('viewer');
    await seedUsage(db, [{ path: old, bytes: ATTACHMENT_CACHE_MAX_BYTES }]);
    const pin = coordinator.protect(old)!;

    expect(await coordinator.reserve(db, { path: path('while-viewing'), maxBytes: 1 })).toEqual({
      status: 'storage',
    });
    pin.release();
    const admitted = await coordinator.reserve(db, { path: path('after-viewing'), maxBytes: 1 });
    expect(admitted.status).toBe('reserved');
    if (admitted.status === 'reserved') await admitted.reservation.release();
  });

  it('conforms current byte overage without reserving a hypothetical incoming file', async () => {
    const { db } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const oldest = path('conform-byte-oldest');
    const recent = path('conform-byte-recent');
    await seedUsage(db, [
      { path: oldest, bytes: 20, lastUsedAt: OLD },
      { path: recent, bytes: ATTACHMENT_CACHE_MAX_BYTES - 15, lastUsedAt: NOW },
    ]);

    await expect(coordinator.conformCurrentQuota(db)).resolves.toEqual({
      status: 'complete',
      withinQuota: true,
      attempted: 1,
      confirmed: 1,
      failed: 0,
      skipped: 0,
    });
    expect(native.deleteFile).toHaveBeenCalledWith(oldest);
    expect(await getAttachmentCacheEntry(db, oldest)).toBeNull();
    expect(await getAttachmentCacheEntry(db, recent)).toMatchObject({ state: 'active' });
  });

  it('conforms a current file-count overage from a bounded ledger snapshot', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const filePath = (index: number): string =>
      path(`conform-files-${String(index).padStart(4, '0')}`);
    const insert = raw.prepare(
      `INSERT INTO attachment_cache_entries
         (path, bytes, last_used_at, state, attempts, next_retry_at)
       VALUES (?, 1, ?, 'active', 0, 0)`,
    );
    raw.transaction(() => {
      for (let index = 0; index <= ATTACHMENT_CACHE_MAX_FILES; index += 1) {
        insert.run(filePath(index), OLD);
      }
    })();

    await expect(coordinator.conformCurrentQuota(db)).resolves.toEqual({
      status: 'complete',
      withinQuota: true,
      attempted: 1,
      confirmed: 1,
      failed: 0,
      skipped: 0,
    });
    expect(native.deleteFile).toHaveBeenCalledWith(filePath(0));
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM attachment_cache_entries`).get()).toEqual({
      count: ATTACHMENT_CACHE_MAX_FILES,
    });
  });

  it('re-reads native free space after exact deletion until the current floor is restored', async () => {
    const { db } = await createTestDb();
    let availableBytes = ATTACHMENT_CACHE_MIN_FREE_BYTES - 6;
    const first = path('conform-free-five');
    const second = path('conform-free-two');
    const getAvailableBytes = jest.fn(async () => availableBytes);
    const deleteFile = jest.fn(async (candidate: string) => {
      availableBytes += candidate === first ? 5 : 2;
      return { status: 'deleted' as const, bytes: candidate === first ? 5 : 2 };
    });
    const coordinator = new AttachmentCacheCoordinator(
      nativeBoundary({ getAvailableBytes, deleteFile }).io,
      () => NOW,
    );
    await seedUsage(db, [
      { path: first, bytes: 5, lastUsedAt: OLD },
      { path: second, bytes: 2, lastUsedAt: OLD + 1 },
    ]);

    await expect(coordinator.conformCurrentQuota(db)).resolves.toEqual({
      status: 'complete',
      withinQuota: true,
      attempted: 2,
      confirmed: 2,
      failed: 0,
      skipped: 0,
    });
    expect(deleteFile.mock.calls.map(([candidate]) => candidate)).toEqual([first, second]);
    expect(getAvailableBytes).toHaveBeenCalledTimes(2);
  });

  it('leaves protected and recent overage charged so future admissions reject', async () => {
    const { db } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const protectedPath = path('conform-protected');
    const recent = path('conform-recent');
    await seedUsage(db, [
      { path: protectedPath, bytes: 20, lastUsedAt: OLD },
      { path: recent, bytes: ATTACHMENT_CACHE_MAX_BYTES - 15, lastUsedAt: NOW },
    ]);
    const pin = coordinator.protect(protectedPath)!;

    await expect(coordinator.conformCurrentQuota(db)).resolves.toEqual({
      status: 'complete',
      withinQuota: false,
      attempted: 0,
      confirmed: 0,
      failed: 0,
      skipped: 0,
    });
    expect(native.deleteFile).not.toHaveBeenCalled();
    await expect(
      coordinator.reserve(db, { path: path('conform-future'), maxBytes: 1 }),
    ).resolves.toEqual({
      status: 'storage',
    });
    expect(await getAttachmentCacheEntry(db, protectedPath)).toMatchObject({ state: 'active' });
    pin.release();
  });

  it('charges a live reserved row even though it is not an eviction candidate', async () => {
    const { db } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const admission = await coordinator.reserve(db, {
      path: path('conform-live-reservation'),
      maxBytes: 10,
    });
    expect(admission.status).toBe('reserved');
    if (admission.status !== 'reserved') throw new Error('expected reservation');
    await seedUsage(db, [
      { path: path('conform-reserved-recent'), bytes: ATTACHMENT_CACHE_MAX_BYTES, lastUsedAt: NOW },
    ]);

    await expect(coordinator.conformCurrentQuota(db)).resolves.toEqual({
      status: 'complete',
      withinQuota: false,
      attempted: 0,
      confirmed: 0,
      failed: 0,
      skipped: 1,
    });
    expect(native.deleteFile).not.toHaveBeenCalled();
    await admission.reservation.release();
  });

  it('replans around an outgoing-protected victim and claims the next safe path', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const queued = path('conform-queued');
    const safe = path('conform-safe');
    const recent = path('conform-outgoing-recent');
    await seedUsage(db, [
      { path: queued, bytes: 20, lastUsedAt: OLD },
      { path: safe, bytes: 20, lastUsedAt: OLD + 1 },
      { path: recent, bytes: ATTACHMENT_CACHE_MAX_BYTES - 35, lastUsedAt: NOW },
    ]);
    raw
      .prepare(
        `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
         VALUES ('temp-conform-queued', 'chat', 'attachment', ?)`,
      )
      .run(JSON.stringify({ attachmentGuid: 'conform-queued-att', localPath: queued }));

    await expect(coordinator.conformCurrentQuota(db)).resolves.toEqual({
      status: 'complete',
      withinQuota: true,
      attempted: 1,
      confirmed: 1,
      failed: 0,
      skipped: 1,
    });
    expect(native.deleteFile).toHaveBeenCalledTimes(1);
    expect(native.deleteFile).toHaveBeenCalledWith(safe);
    expect(await getAttachmentCacheEntry(db, queued)).toMatchObject({ state: 'active' });
    expect(await getAttachmentCacheEntry(db, safe)).toBeNull();
  });

  it('keeps a failed path charged, then replans and deletes another exact candidate', async () => {
    const { db } = await createTestDb();
    const first = path('conform-delete-failed');
    const second = path('conform-delete-replanned');
    const recent = path('conform-delete-recent');
    const deleteFile = jest.fn((candidate: string) =>
      candidate === first
        ? Promise.reject(new Error('disk busy'))
        : Promise.resolve({ status: 'deleted' as const, bytes: 20 }),
    );
    const coordinator = new AttachmentCacheCoordinator(
      nativeBoundary({ deleteFile }).io,
      () => NOW,
    );
    await seedUsage(db, [
      { path: first, bytes: 20, lastUsedAt: OLD },
      { path: second, bytes: 20, lastUsedAt: OLD + 1 },
      { path: recent, bytes: ATTACHMENT_CACHE_MAX_BYTES - 35, lastUsedAt: NOW },
    ]);

    await expect(coordinator.conformCurrentQuota(db)).resolves.toEqual({
      status: 'complete',
      withinQuota: true,
      attempted: 2,
      confirmed: 1,
      failed: 1,
      skipped: 0,
    });
    expect(deleteFile.mock.calls.map(([candidate]) => candidate)).toEqual([first, second]);
    expect(await getAttachmentCacheEntry(db, first)).toMatchObject({
      state: 'retiring',
      attempts: 1,
    });
    expect(await getAttachmentCacheEntry(db, second)).toBeNull();
  });

  it('never claims more than 100 current-conformance paths in one DB batch', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const candidates = Array.from({ length: 101 }, (_, index) => ({
      path: path(`conform-batch-${String(index).padStart(3, '0')}`),
      bytes: 1,
      lastUsedAt: OLD,
    }));
    await seedUsage(db, [
      ...candidates,
      { path: path('conform-batch-recent'), bytes: ATTACHMENT_CACHE_MAX_BYTES, lastUsedAt: NOW },
    ]);
    const claimSizes: number[] = [];
    let trackedSnapshots = 0;
    const transactionAtDelete: boolean[] = [];
    const transactionAtQuotaSnapshot: boolean[] = [];
    type All = (...args: Parameters<AppDatabase['all']>) => ReturnType<AppDatabase['all']>;
    const realAll = db.all.bind(db) as All;
    const allSpy = jest.spyOn(db, 'all').mockImplementation(((...args) => {
      const shape = JSON.stringify(args[0]).replace(/\s+/g, ' ').toLowerCase();
      if (shape.includes('candidate_page') && shape.includes('usage_files')) {
        transactionAtQuotaSnapshot.push(raw.inTransaction);
      }
      return realAll(...args);
    }) as AppDatabase['all']);
    native.deleteFile.mockImplementation(async () => {
      transactionAtDelete.push(raw.inTransaction);
      return { status: 'deleted', bytes: 1 };
    });
    const scope: AttachmentCacheReservationScope = {
      generation: 10,
      isCurrent: () => true,
      runTracked: async <T>(task: () => Promise<T>): Promise<T> => {
        const result = await task();
        const inspected = (typeof result === 'object' && result !== null ? result : {}) as {
          status?: unknown;
          paths?: unknown;
          usage?: unknown;
          candidates?: unknown;
        };
        if (inspected.usage !== undefined && Array.isArray(inspected.candidates)) {
          trackedSnapshots += 1;
        }
        if (inspected.status === 'claimed' && Array.isArray(inspected.paths)) {
          claimSizes.push(inspected.paths.length);
        }
        return result;
      },
    };

    try {
      await expect(coordinator.conformCurrentQuota(db, { scope })).resolves.toEqual({
        status: 'complete',
        withinQuota: true,
        attempted: 101,
        confirmed: 101,
        failed: 0,
        skipped: 0,
      });
      expect(trackedSnapshots).toBe(3);
      expect(transactionAtQuotaSnapshot).toEqual([true, true, true]);
      expect(claimSizes).toEqual([100, 1]);
      expect(transactionAtDelete).toEqual(Array.from({ length: 101 }, () => false));
    } finally {
      allSpy.mockRestore();
      raw.close();
    }
  });

  it('rolls back a failed tracked conformance claim and retries after pending cleanup', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const victim = path('conform-claim-rollback');
    const recent = path('conform-claim-rollback-recent');
    await seedUsage(db, [
      { path: victim, bytes: 20, lastUsedAt: OLD },
      { path: recent, bytes: ATTACHMENT_CACHE_MAX_BYTES - 15, lastUsedAt: NOW },
    ]);
    raw
      .prepare(
        `INSERT INTO attachments (guid, local_path)
         VALUES ('conform-rollback-a', ?), ('conform-rollback-b', ?)`,
      )
      .run(victim, victim);
    raw.exec(`
      CREATE TRIGGER fail_conformance_cache_reference_clear
      BEFORE UPDATE OF local_path ON attachments
      WHEN OLD.local_path = '${victim}'
      BEGIN
        SELECT RAISE(ABORT, 'forced conformance reference clear failure');
      END
    `);
    const recentPin = coordinator.protect(recent)!;
    const trackedScope = (): AttachmentCacheReservationScope => ({
      generation: 13,
      isCurrent: () => true,
      runTracked: <T>(task: () => Promise<T>) => task(),
    });

    try {
      const failure = await coordinator.conformCurrentQuota(db, { scope: trackedScope() }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({
        name: 'SqliteError',
        code: 'SQLITE_CONSTRAINT_TRIGGER',
        message: 'forced conformance reference clear failure',
      });
      expect(native.deleteFile).not.toHaveBeenCalled();
      expect(await getAttachmentCacheEntry(db, victim)).toMatchObject({ state: 'active' });
      expect(
        raw
          .prepare(
            `SELECT guid, local_path AS localPath
             FROM attachments WHERE guid LIKE 'conform-rollback-%' ORDER BY guid`,
          )
          .all(),
      ).toEqual([
        { guid: 'conform-rollback-a', localPath: victim },
        { guid: 'conform-rollback-b', localPath: victim },
      ]);

      raw.exec('DROP TRIGGER fail_conformance_cache_reference_clear');
      const pendingProbe = coordinator.protect(victim);
      expect(pendingProbe).not.toBeNull();
      pendingProbe?.release();

      await expect(coordinator.conformCurrentQuota(db, { scope: trackedScope() })).resolves.toEqual(
        {
          status: 'complete',
          withinQuota: true,
          attempted: 1,
          confirmed: 1,
          failed: 0,
          skipped: 0,
        },
      );
      expect(native.deleteFile).toHaveBeenCalledWith(victim);
      expect(await getAttachmentCacheEntry(db, victim)).toBeNull();
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS fail_conformance_cache_reference_clear');
      recentPin.release();
      raw.close();
    }
  });

  it('rejects a tracked conformance claim revoked before commit, then retries fresh', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const victim = path('conform-claim-revoked');
    const recent = path('conform-claim-revoked-recent');
    await seedUsage(db, [
      { path: victim, bytes: 20, lastUsedAt: OLD },
      { path: recent, bytes: ATTACHMENT_CACHE_MAX_BYTES - 15, lastUsedAt: NOW },
    ]);
    raw
      .prepare(`INSERT INTO attachments (guid, local_path) VALUES ('conform-revoked-ref', ?) `)
      .run(victim);
    const staleScope = accountScope(db, 15);
    raw.function('test_revoke_conformance_claim', () => staleScope.revoke());
    raw.exec(`
      CREATE TRIGGER revoke_conformance_cache_claim
      AFTER UPDATE OF state ON attachment_cache_entries
      WHEN OLD.path = '${victim}' AND NEW.state = 'retiring'
      BEGIN
        SELECT test_revoke_conformance_claim();
      END
    `);
    const recentPin = coordinator.protect(recent)!;

    try {
      await expect(coordinator.conformCurrentQuota(db, { scope: staleScope })).resolves.toEqual({
        status: 'stale',
        withinQuota: false,
        attempted: 0,
        confirmed: 0,
        failed: 0,
        skipped: 0,
      });
      expect(native.deleteFile).not.toHaveBeenCalled();
      expect(await getAttachmentCacheEntry(db, victim)).toMatchObject({ state: 'active' });
      expect(
        raw
          .prepare(
            `SELECT local_path AS localPath FROM attachments WHERE guid = 'conform-revoked-ref'`,
          )
          .get(),
      ).toEqual({ localPath: victim });
      const pendingProbe = coordinator.protect(victim);
      expect(pendingProbe).not.toBeNull();
      pendingProbe?.release();

      raw.exec('DROP TRIGGER revoke_conformance_cache_claim');
      await expect(
        coordinator.conformCurrentQuota(db, { scope: accountScope(db, 16) }),
      ).resolves.toEqual({
        status: 'complete',
        withinQuota: true,
        attempted: 1,
        confirmed: 1,
        failed: 0,
        skipped: 0,
      });
      expect(native.deleteFile).toHaveBeenCalledWith(victim);
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS revoke_conformance_cache_claim');
      recentPin.release();
      raw.close();
    }
  });

  it('owns unscoped conformance transactions directly and keeps native work outside', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary();
    const nativeTransactions: boolean[] = [];
    native.getAvailableBytes.mockImplementation(async () => {
      nativeTransactions.push(raw.inTransaction);
      return ATTACHMENT_CACHE_MIN_FREE_BYTES + ATTACHMENT_CACHE_MAX_BYTES;
    });
    native.deleteFile.mockImplementation(async () => {
      nativeTransactions.push(raw.inTransaction);
      return { status: 'deleted', bytes: 20 };
    });
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const victim = path('conform-fallback');
    const recent = path('conform-fallback-recent');
    await seedUsage(db, [
      { path: victim, bytes: 20, lastUsedAt: OLD },
      { path: recent, bytes: ATTACHMENT_CACHE_MAX_BYTES - 15, lastUsedAt: NOW },
    ]);
    const recentPin = coordinator.protect(recent)!;

    try {
      const observed = await observeDbAllTransactionState(db, raw, () =>
        coordinator.conformCurrentQuota(db),
      );
      expect(observed.value).toEqual({
        status: 'complete',
        withinQuota: true,
        attempted: 1,
        confirmed: 1,
        failed: 0,
        skipped: 0,
      });
      expect(observed.transactionStates.length).toBeGreaterThan(0);
      expect(observed.transactionStates.every(Boolean)).toBe(true);
      expect(nativeTransactions.length).toBeGreaterThan(0);
      expect(nativeTransactions.every((state) => !state)).toBe(true);
      expect(native.deleteFile).toHaveBeenCalledWith(victim);
    } finally {
      recentPin.release();
      raw.close();
    }
  });

  it('never claims more than 100 admission victims through the tracked owner', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const candidates = Array.from({ length: 101 }, (_, index) => ({
      path: path(`admission-batch-${String(index).padStart(3, '0')}`),
      bytes: 1,
      lastUsedAt: OLD,
    }));
    const recent = path('admission-batch-recent');
    await seedUsage(db, [
      ...candidates,
      { path: recent, bytes: ATTACHMENT_CACHE_MAX_BYTES - 1, lastUsedAt: NOW },
    ]);
    const recentPin = coordinator.protect(recent)!;
    const claimSizes: number[] = [];
    let trackedSnapshots = 0;
    const transactionAtDelete: boolean[] = [];
    const transactionAtQuotaSnapshot: boolean[] = [];
    type All = (...args: Parameters<AppDatabase['all']>) => ReturnType<AppDatabase['all']>;
    const realAll = db.all.bind(db) as All;
    const allSpy = jest.spyOn(db, 'all').mockImplementation(((...args) => {
      const shape = JSON.stringify(args[0]).replace(/\s+/g, ' ').toLowerCase();
      if (shape.includes('candidate_page') && shape.includes('usage_files')) {
        transactionAtQuotaSnapshot.push(raw.inTransaction);
      }
      return realAll(...args);
    }) as AppDatabase['all']);
    native.deleteFile.mockImplementation(async () => {
      transactionAtDelete.push(raw.inTransaction);
      return { status: 'deleted', bytes: 1 };
    });
    const scope: AttachmentCacheReservationScope = {
      generation: 10,
      isCurrent: () => true,
      runTracked: async <T>(task: () => Promise<T>): Promise<T> => {
        const result = await task();
        const inspected = (typeof result === 'object' && result !== null ? result : {}) as {
          status?: unknown;
          paths?: unknown;
          requested?: unknown;
          quota?: unknown;
        };
        if ('requested' in inspected && inspected.quota !== undefined) trackedSnapshots += 1;
        if (inspected.status === 'claimed' && Array.isArray(inspected.paths)) {
          claimSizes.push(inspected.paths.length);
        }
        return result;
      },
    };

    try {
      const admission = await coordinator.reserve(db, {
        path: path('admission-batch-new'),
        maxBytes: 1,
        scope,
      });

      expect(admission.status).toBe('reserved');
      expect(trackedSnapshots).toBe(3);
      expect(transactionAtQuotaSnapshot).toEqual([true, true, true]);
      expect(claimSizes).toEqual([100, 1]);
      expect(native.deleteFile).toHaveBeenCalledTimes(101);
      expect(transactionAtDelete).toEqual(Array.from({ length: 101 }, () => false));
      if (admission.status === 'reserved') await admission.reservation.release();
    } finally {
      allSpy.mockRestore();
      recentPin.release();
      raw.close();
    }
  });

  it('settles tracked deleted and missing results after a rolling neighbour', async () => {
    const { db, raw } = await createTestDb();
    const deleted = path('tracked-settle-deleted');
    const missing = path('tracked-settle-missing');
    await seedUsage(db, [
      { path: deleted, bytes: 10 },
      { path: missing, bytes: 20 },
    ]);
    await withDbTransaction(db, async (context) => {
      const claim = await claimAttachmentCachePathsForRetirement(context, [deleted, missing]);
      if (claim.status !== 'claimed') throw new Error(`test setup claim refused: ${claim.reason}`);
    });

    let releaseNeighbour!: () => void;
    const neighbourGate = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    let neighbourStarted = false;
    let neighbour: ReturnType<typeof observe<void>> | undefined;
    const transactionAtDelete: boolean[] = [];
    const deleteFile = jest.fn(async (candidate: string) => {
      transactionAtDelete.push(raw.inTransaction);
      if (candidate === deleted) {
        neighbour = observe(
          withDbTransaction(db, async (_context) => {
            raw
              .prepare("INSERT INTO kv (key, value) VALUES ('cache-settle-neighbour', 'dirty')")
              .run();
            neighbourStarted = true;
            await neighbourGate;
            throw new Error('cache settlement neighbour rollback');
          }),
        );
        return { status: 'deleted' as const, bytes: 10 };
      }
      return { status: 'missing' as const, bytes: 0 };
    });
    const coordinator = new AttachmentCacheCoordinator(
      nativeBoundary({ deleteFile }).io,
      () => NOW,
    );
    const scope = accountScope(db);
    const drain = observe(coordinator.drainDueRetirements(db, { scope }));

    try {
      await waitFor(() => neighbourStarted, 'tracked settlement neighbour');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(drain.settled()).toBe(false);

      releaseNeighbour();
      await expect(neighbour?.outcome).resolves.toMatchObject({ kind: 'rejected' });
      await expect(drain.outcome).resolves.toEqual({
        kind: 'fulfilled',
        value: { status: 'complete', attempted: 2, confirmed: 2, failed: 0, skipped: 0 },
      });
      expect(transactionAtDelete).toEqual([false, false]);
      expect(
        raw.prepare("SELECT value FROM kv WHERE key = 'cache-settle-neighbour'").get(),
      ).toBeUndefined();
      expect(await getAttachmentCacheEntry(db, deleted)).toBeNull();
      expect(await getAttachmentCacheEntry(db, missing)).toBeNull();
    } finally {
      releaseNeighbour();
      await Promise.allSettled([neighbour?.outcome ?? Promise.resolve(), drain.outcome]);
      raw.close();
    }
  });

  it('persists tracked native failure backoff and releases path ownership for retry', async () => {
    const { db, raw } = await createTestDb();
    const failed = path('tracked-settle-failed');
    await seedUsage(db, [{ path: failed, bytes: 20 }]);
    await withDbTransaction(db, async (context) => {
      const claim = await claimAttachmentCachePathsForRetirement(context, [failed]);
      if (claim.status !== 'claimed') throw new Error(`test setup claim refused: ${claim.reason}`);
    });

    let releaseNeighbour!: () => void;
    const neighbourGate = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    let neighbourStarted = false;
    let neighbour: ReturnType<typeof observe<void>> | undefined;
    let transactionAtDelete: boolean | undefined;
    const deleteFile = jest
      .fn<Promise<{ status: 'deleted' | 'missing'; bytes: number }>, [string]>()
      .mockImplementationOnce(async () => {
        transactionAtDelete = raw.inTransaction;
        neighbour = observe(
          withDbTransaction(db, async (_context) => {
            raw
              .prepare("INSERT INTO kv (key, value) VALUES ('cache-retry-neighbour', 'dirty')")
              .run();
            neighbourStarted = true;
            await neighbourGate;
            throw new Error('cache retry neighbour rollback');
          }),
        );
        throw new Error('native delete failed');
      })
      .mockResolvedValueOnce({ status: 'missing', bytes: 0 });
    let now = NOW;
    const coordinator = new AttachmentCacheCoordinator(
      nativeBoundary({ deleteFile }).io,
      () => now,
    );
    const scope = accountScope(db);
    const firstDrain = observe(coordinator.drainDueRetirements(db, { scope }));

    try {
      await waitFor(() => neighbourStarted, 'tracked retry neighbour');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(firstDrain.settled()).toBe(false);

      releaseNeighbour();
      await expect(neighbour?.outcome).resolves.toMatchObject({ kind: 'rejected' });
      await expect(firstDrain.outcome).resolves.toEqual({
        kind: 'fulfilled',
        value: { status: 'complete', attempted: 1, confirmed: 0, failed: 1, skipped: 0 },
      });
      expect(transactionAtDelete).toBe(false);
      expect(await getAttachmentCacheEntry(db, failed)).toMatchObject({
        state: 'retiring',
        attempts: 1,
        nextRetryAt: NOW + 5_000,
      });
      expect(
        raw.prepare("SELECT value FROM kv WHERE key = 'cache-retry-neighbour'").get(),
      ).toBeUndefined();

      now += 5_000;
      await expect(coordinator.drainDueRetirements(db, { scope })).resolves.toEqual({
        status: 'complete',
        attempted: 1,
        confirmed: 1,
        failed: 0,
        skipped: 0,
      });
      expect(await getAttachmentCacheEntry(db, failed)).toBeNull();
    } finally {
      releaseNeighbour();
      await Promise.allSettled([neighbour?.outcome ?? Promise.resolve(), firstDrain.outcome]);
      raw.close();
    }
  });

  it('keeps a tracked retiring row durable when confirm fails after native absence', async () => {
    const { db, raw } = await createTestDb();
    const retained = path('tracked-confirm-failed');
    await seedUsage(db, [{ path: retained, bytes: 20 }]);
    await withDbTransaction(db, async (context) => {
      const claim = await claimAttachmentCachePathsForRetirement(context, [retained]);
      if (claim.status !== 'claimed') throw new Error(`test setup claim refused: ${claim.reason}`);
    });
    raw.exec(`
      CREATE TRIGGER fail_tracked_cache_confirm
      BEFORE DELETE ON attachment_cache_entries
      WHEN OLD.path = '${retained}'
      BEGIN
        SELECT RAISE(ABORT, 'forced tracked confirm failure');
      END
    `);
    const native = nativeBoundary();
    native.deleteFile.mockResolvedValue({ status: 'missing', bytes: 0 });
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const scope = accountScope(db);

    try {
      await expect(coordinator.drainDueRetirements(db, { scope })).resolves.toEqual({
        status: 'complete',
        attempted: 1,
        confirmed: 0,
        failed: 1,
        skipped: 0,
      });
      expect(await getAttachmentCacheEntry(db, retained)).toMatchObject({
        state: 'retiring',
        attempts: 0,
        nextRetryAt: 0,
      });

      raw.exec('DROP TRIGGER fail_tracked_cache_confirm');
      await expect(coordinator.drainDueRetirements(db, { scope })).resolves.toEqual({
        status: 'complete',
        attempted: 1,
        confirmed: 1,
        failed: 0,
        skipped: 0,
      });
      expect(native.deleteFile).toHaveBeenCalledTimes(2);
      expect(await getAttachmentCacheEntry(db, retained)).toBeNull();
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS fail_tracked_cache_confirm');
      raw.close();
    }
  });

  it('rejects a stale account without installing a reservation', async () => {
    const { db } = await createTestDb();
    const coordinator = new AttachmentCacheCoordinator(nativeBoundary().io, () => NOW);
    const scope = accountScope(db);
    scope.revoke();

    expect(await coordinator.reserve(db, { path: path('stale'), maxBytes: 10, scope })).toEqual({
      status: 'stale',
    });
  });

  it('stops current conformance before native work for a stale account', async () => {
    const { db } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const scope = accountScope(db);
    scope.revoke();

    await expect(coordinator.conformCurrentQuota(db, { scope })).resolves.toEqual({
      status: 'stale',
      withinQuota: false,
      attempted: 0,
      confirmed: 0,
      failed: 0,
      skipped: 0,
    });
    expect(native.getAvailableBytes).not.toHaveBeenCalled();
    expect(native.deleteFile).not.toHaveBeenCalled();
  });

  it('recovers due retirement rows, confirms missing files, and backs off failures', async () => {
    const { db, raw } = await createTestDb();
    const native = nativeBoundary();
    const coordinator = new AttachmentCacheCoordinator(native.io, () => NOW);
    const missing = path('recover-missing');
    const failed = path('recover-failed');
    await seedUsage(db, [
      { path: missing, bytes: 10 },
      { path: failed, bytes: 20 },
    ]);
    await withDbTransaction(db, async (context) => {
      const claim = await claimAttachmentCachePathsForRetirement(context, [missing, failed]);
      if (claim.status !== 'claimed') throw new Error(`test setup claim refused: ${claim.reason}`);
    });
    const deleteTransactions: boolean[] = [];
    native.deleteFile.mockImplementation((candidate: string) => {
      deleteTransactions.push(raw.inTransaction);
      return candidate === missing
        ? Promise.resolve({ status: 'missing', bytes: 0 })
        : Promise.reject(new Error('still busy'));
    });

    const observed = await observeDbAllTransactionState(db, raw, () =>
      coordinator.drainDueRetirements(db),
    );
    expect(observed.value).toEqual({
      status: 'complete',
      attempted: 2,
      confirmed: 1,
      failed: 1,
      skipped: 0,
    });
    expect(observed.transactionStates.length).toBeGreaterThan(0);
    expect(observed.transactionStates.every(Boolean)).toBe(true);
    expect(deleteTransactions).toEqual([false, false]);
    expect(await getAttachmentCacheEntry(db, missing)).toBeNull();
    expect(await getAttachmentCacheEntry(db, failed)).toMatchObject({
      state: 'retiring',
      attempts: 1,
      nextRetryAt: NOW + 5_000,
    });
  });
});
