import {
  adoptAttachmentCacheScanBatch,
  ATTACHMENT_CACHE_RETIREMENT_RETRY_MAX_MS,
  attachmentCacheRetirementBackoffMs,
  claimAttachmentCachePathsForRetirement,
  commitAttachmentCacheReservation,
  confirmAttachmentCacheEntryDeleted,
  createAttachmentCacheReservation,
  deleteMessageLocal,
  getAttachmentCacheEntry,
  getAttachmentCacheQuotaSnapshot,
  getAttachmentCacheUsage,
  listAttachmentCacheEntriesForRecovery,
  listInactiveAttachmentCachePaths,
  listDueAttachmentCacheRetirements,
  recordAttachmentCacheEntry,
  recordAttachmentCacheAccess,
  repairMissingActiveAttachmentCacheEntry,
  scheduleAttachmentCacheRetirementRetry,
} from '@db/repositories';
import {
  DbTransactionContextRejectedError,
  withDbTransaction,
  type DbTransactionContext,
} from '@db/transaction';
import { createTestDb } from '../support/testDb';

const PATH = 'file:///documents/attachments/aa/file.jpg';
const MAX_REFERENCE_CLEAR_ROWS = 1000;
type TestDatabase = Awaited<ReturnType<typeof createTestDb>>['raw'];

function seedAttachmentReferences(
  raw: TestDatabase,
  path: string,
  count: number,
  prefix: string,
): void {
  const insert = raw.prepare(`INSERT INTO attachments (guid, local_path) VALUES (?, ?)`);
  raw.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      insert.run(`${prefix}-${index}`, path);
    }
  })();
}

function countAttachmentReferences(raw: TestDatabase, path: string): number {
  const row = raw
    .prepare(`SELECT COUNT(*) AS count FROM attachments WHERE local_path = ?`)
    .get(path) as { count: number };
  return row.count;
}

describe('attachment cache ledger', () => {
  it('rejects stale or forged transaction contexts and rolls joined writes back', async () => {
    const { db } = await createTestDb();
    const stalePath = `${PATH}-stale`;
    const forgedPath = `${PATH}-forged`;
    const rolledBackPath = `${PATH}-rolled-back`;
    let staleContext!: DbTransactionContext;

    await withDbTransaction(db, async (context) => {
      staleContext = context;
    });
    await expect(
      createAttachmentCacheReservation(staleContext, {
        path: stalePath,
        maxBytes: 10,
        createdAt: 1,
      }),
    ).rejects.toBeInstanceOf(DbTransactionContextRejectedError);

    const forgedContext = Object.freeze({}) as DbTransactionContext;
    await expect(
      createAttachmentCacheReservation(forgedContext, {
        path: forgedPath,
        maxBytes: 10,
        createdAt: 1,
      }),
    ).rejects.toBeInstanceOf(DbTransactionContextRejectedError);

    await expect(
      withDbTransaction(db, async (context) => {
        await createAttachmentCacheReservation(context, {
          path: rolledBackPath,
          maxBytes: 10,
          createdAt: 1,
        });
        throw new Error('roll back attachment-cache proof');
      }),
    ).rejects.toThrow('roll back attachment-cache proof');

    await expect(getAttachmentCacheEntry(db, stalePath)).resolves.toBeNull();
    await expect(getAttachmentCacheEntry(db, forgedPath)).resolves.toBeNull();
    await expect(getAttachmentCacheEntry(db, rolledBackPath)).resolves.toBeNull();
  });

  it('durably charges a native reservation, commits exact bytes, and recovers an abandoned one', async () => {
    const { db } = await createTestDb();
    expect(
      await withDbTransaction(db, (context) =>
        createAttachmentCacheReservation(context, {
          path: PATH,
          maxBytes: 100,
          createdAt: 50,
        }),
      ),
    ).toBe(true);
    expect(
      await withDbTransaction(db, (context) =>
        createAttachmentCacheReservation(context, {
          path: PATH,
          maxBytes: 100,
          createdAt: 51,
        }),
      ),
    ).toBe(false);
    expect(await getAttachmentCacheEntry(db, PATH)).toEqual({
      path: PATH,
      bytes: 100,
      lastUsedAt: 50,
      state: 'reserved',
      attempts: 0,
      nextRetryAt: 0,
    });
    expect(await getAttachmentCacheUsage(db)).toEqual({ files: 1, bytes: 100 });
    expect(await listDueAttachmentCacheRetirements(db, 0)).toEqual([
      expect.objectContaining({ path: PATH, state: 'reserved', bytes: 100 }),
    ]);

    expect(
      await withDbTransaction(db, (context) =>
        commitAttachmentCacheReservation(context, {
          path: PATH,
          bytes: 60,
          lastUsedAt: 75,
        }),
      ),
    ).toBe(true);
    expect(await getAttachmentCacheEntry(db, PATH)).toMatchObject({
      state: 'active',
      bytes: 60,
      lastUsedAt: 75,
    });
    expect(
      await withDbTransaction(db, (context) =>
        commitAttachmentCacheReservation(context, {
          path: PATH,
          bytes: 60,
          lastUsedAt: 80,
        }),
      ),
    ).toBe(false);

    const abandoned = 'file:///documents/attachments/aa/abandoned.jpg';
    await withDbTransaction(db, (context) =>
      createAttachmentCacheReservation(context, {
        path: abandoned,
        maxBytes: 80,
        createdAt: 90,
      }),
    );
    expect(
      await withDbTransaction(db, (context) =>
        scheduleAttachmentCacheRetirementRetry(context, abandoned, 100),
      ),
    ).toEqual({
      attempts: 1,
      nextRetryAt: 5_100,
    });
    expect(await getAttachmentCacheEntry(db, abandoned)).toMatchObject({
      state: 'retiring',
      bytes: 80,
    });
    expect(
      await withDbTransaction(db, (context) =>
        confirmAttachmentCacheEntryDeleted(context, abandoned),
      ),
    ).toBe(true);
  });

  it('records one active row per path and never regresses a newer observation', async () => {
    const { db, raw } = await createTestDb();
    expect(
      await withDbTransaction(db, (context) =>
        recordAttachmentCacheEntry(context, { path: PATH, bytes: 50, lastUsedAt: 200 }),
      ),
    ).toBe(true);
    // A stale completion must not move access time or its matching byte observation backward.
    expect(
      await withDbTransaction(db, (context) =>
        recordAttachmentCacheEntry(context, { path: PATH, bytes: 10, lastUsedAt: 100 }),
      ),
    ).toBe(true);
    expect(await getAttachmentCacheEntry(db, PATH)).toEqual({
      path: PATH,
      bytes: 50,
      lastUsedAt: 200,
      state: 'active',
      attempts: 0,
      nextRetryAt: 0,
    });

    expect(
      await withDbTransaction(db, (context) =>
        recordAttachmentCacheEntry(context, { path: PATH, bytes: 60, lastUsedAt: 300 }),
      ),
    ).toBe(true);
    expect(await getAttachmentCacheUsage(db)).toEqual({ files: 1, bytes: 60 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM attachment_cache_entries').get()).toEqual({
      count: 1,
    });
  });

  it('adopts a bounded native scan page and refreshes exact bytes without reviving sticky states', async () => {
    const { db } = await createTestDb();
    const active = `${PATH}-active`;
    const reserved = `${PATH}-reserved`;
    const retiring = `${PATH}-retiring`;
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: active, bytes: 10, lastUsedAt: 500 }),
    );
    await withDbTransaction(db, (context) =>
      createAttachmentCacheReservation(context, {
        path: reserved,
        maxBytes: 100,
        createdAt: 100,
      }),
    );
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: retiring, bytes: 30, lastUsedAt: 100 }),
    );
    await withDbTransaction(db, async (context) => {
      const claim = await claimAttachmentCachePathsForRetirement(context, [retiring]);
      if (claim.status !== 'claimed') throw new Error(`test retirement refused: ${claim.reason}`);
    });

    await expect(
      withDbTransaction(db, (context) =>
        adoptAttachmentCacheScanBatch(context, [
          { path: PATH, bytes: 0, lastUsedAt: 200 },
          { path: active, bytes: 25, lastUsedAt: 400 },
          { path: reserved, bytes: 40, lastUsedAt: 200 },
          { path: retiring, bytes: 30, lastUsedAt: 200 },
        ]),
      ),
    ).resolves.toEqual({
      activePaths: [active],
      retiringPaths: [PATH],
      deferredPaths: [reserved, retiring],
    });
    expect(await getAttachmentCacheEntry(db, PATH)).toMatchObject({
      state: 'retiring',
      bytes: 0,
      lastUsedAt: 200,
    });
    expect(await getAttachmentCacheEntry(db, active)).toMatchObject({
      state: 'active',
      bytes: 25,
      lastUsedAt: 500,
    });
    expect(await getAttachmentCacheEntry(db, reserved)).toMatchObject({
      state: 'reserved',
      bytes: 100,
    });
    expect(await getAttachmentCacheEntry(db, retiring)).toMatchObject({ state: 'retiring' });
  });

  it('rejects duplicate recovery observations before issuing a write', async () => {
    const { db } = await createTestDb();

    await expect(
      withDbTransaction(db, (context) =>
        adoptAttachmentCacheScanBatch(context, [
          { path: PATH, bytes: 1, lastUsedAt: 1 },
          { path: PATH, bytes: 2, lastUsedAt: 2 },
        ]),
      ),
    ).rejects.toThrow('must be unique');
    expect(await listAttachmentCacheEntriesForRecovery(db)).toEqual([]);
  });

  it('clears zero-byte references and clamps corrupt future access time in the outer transaction', async () => {
    const { db, raw } = await createTestDb();
    const zero = `${PATH}-zero`;
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: zero, bytes: 10, lastUsedAt: 50_000 }),
    );
    raw.prepare(`INSERT INTO attachments (guid, local_path) VALUES ('zero-cache', ?)`).run(zero);

    await expect(
      withDbTransaction(db, (context) =>
        adoptAttachmentCacheScanBatch(context, [{ path: zero, bytes: 0, lastUsedAt: 1 }], 100),
      ),
    ).resolves.toEqual({ activePaths: [], retiringPaths: [zero], deferredPaths: [] });
    expect(await getAttachmentCacheEntry(db, zero)).toMatchObject({
      state: 'retiring',
      bytes: 0,
      lastUsedAt: 100,
    });
    expect(
      raw
        .prepare(`SELECT local_path AS localPath FROM attachments WHERE guid = 'zero-cache'`)
        .get(),
    ).toEqual({ localPath: null });
  });

  it('caps zero-byte recovery reference clearing at exactly 1,000 rows', async () => {
    const accepted = await createTestDb();
    const acceptedPaths = [
      `${PATH}-zero-reference-limit-a`,
      `${PATH}-zero-reference-limit-b`,
    ] as const;
    for (const path of acceptedPaths) {
      await withDbTransaction(accepted.db, (context) =>
        recordAttachmentCacheEntry(context, {
          path,
          bytes: 10,
          lastUsedAt: 1,
        }),
      );
    }
    seedAttachmentReferences(
      accepted.raw,
      acceptedPaths[0],
      MAX_REFERENCE_CLEAR_ROWS / 2,
      'accepted-zero-reference-a',
    );
    seedAttachmentReferences(
      accepted.raw,
      acceptedPaths[1],
      MAX_REFERENCE_CLEAR_ROWS / 2,
      'accepted-zero-reference-b',
    );

    await expect(
      withDbTransaction(accepted.db, (context) =>
        adoptAttachmentCacheScanBatch(
          context,
          acceptedPaths.map((path) => ({ path, bytes: 0, lastUsedAt: 2 })),
        ),
      ),
    ).resolves.toEqual({
      activePaths: [],
      retiringPaths: acceptedPaths,
      deferredPaths: [],
    });
    for (const path of acceptedPaths) {
      expect(countAttachmentReferences(accepted.raw, path)).toBe(0);
      expect(await getAttachmentCacheEntry(accepted.db, path)).toMatchObject({
        bytes: 0,
        state: 'retiring',
      });
    }

    const refused = await createTestDb();
    const refusedPaths = [
      `${PATH}-zero-reference-overflow-a`,
      `${PATH}-zero-reference-overflow-b`,
    ] as const;
    for (const path of refusedPaths) {
      await withDbTransaction(refused.db, (context) =>
        recordAttachmentCacheEntry(context, {
          path,
          bytes: 10,
          lastUsedAt: 1,
        }),
      );
    }
    seedAttachmentReferences(
      refused.raw,
      refusedPaths[0],
      MAX_REFERENCE_CLEAR_ROWS / 2,
      'refused-zero-reference-a',
    );
    seedAttachmentReferences(
      refused.raw,
      refusedPaths[1],
      MAX_REFERENCE_CLEAR_ROWS / 2 + 1,
      'refused-zero-reference-b',
    );

    await expect(
      withDbTransaction(refused.db, (context) =>
        adoptAttachmentCacheScanBatch(
          context,
          refusedPaths.map((path) => ({ path, bytes: 0, lastUsedAt: 2 })),
        ),
      ),
    ).rejects.toThrow('must not exceed 1000 rows per transaction');
    expect(
      refusedPaths.reduce((count, path) => count + countAttachmentReferences(refused.raw, path), 0),
    ).toBe(MAX_REFERENCE_CLEAR_ROWS + 1);
    for (const path of refusedPaths) {
      expect(await getAttachmentCacheEntry(refused.db, path)).toMatchObject({
        bytes: 10,
        lastUsedAt: 1,
        state: 'active',
      });
    }
  });

  it('lists durable recovery owners in exact deterministic path order', async () => {
    const { db } = await createTestDb();
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: `${PATH}-z`, bytes: 1, lastUsedAt: 1 }),
    );
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: `${PATH}-a`, bytes: 2, lastUsedAt: 2 }),
    );

    await expect(listAttachmentCacheEntriesForRecovery(db)).resolves.toEqual([
      expect.objectContaining({ path: `${PATH}-a`, state: 'active' }),
      expect.objectContaining({ path: `${PATH}-z`, state: 'active' }),
    ]);
  });

  it('coalesces access-time writes while immediately repairing exact byte accounting', async () => {
    const { db } = await createTestDb();
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: PATH, bytes: 50, lastUsedAt: 1_000 }),
    );

    await expect(
      withDbTransaction(db, (context) =>
        recordAttachmentCacheAccess(context, {
          path: PATH,
          bytes: 50,
          observedAt: 1_050,
          touchIntervalMs: 100,
        }),
      ),
    ).resolves.toBe('coalesced');
    expect(await getAttachmentCacheEntry(db, PATH)).toMatchObject({
      bytes: 50,
      lastUsedAt: 1_000,
    });

    await expect(
      withDbTransaction(db, (context) =>
        recordAttachmentCacheAccess(context, {
          path: PATH,
          bytes: 75,
          observedAt: 1_075,
          touchIntervalMs: 100,
        }),
      ),
    ).resolves.toBe('touched');
    expect(await getAttachmentCacheEntry(db, PATH)).toMatchObject({
      bytes: 75,
      lastUsedAt: 1_000,
    });

    await expect(
      withDbTransaction(db, (context) =>
        recordAttachmentCacheAccess(context, {
          path: PATH,
          bytes: 75,
          observedAt: 1_100,
          touchIntervalMs: 100,
        }),
      ),
    ).resolves.toBe('touched');
    expect(await getAttachmentCacheEntry(db, PATH)).toMatchObject({
      bytes: 75,
      lastUsedAt: 1_100,
    });
  });

  it('atomically clears every reference and ledger row for an active file proved missing', async () => {
    const { db, raw } = await createTestDb();
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: PATH, bytes: 50, lastUsedAt: 1_000 }),
    );
    raw
      .prepare(`INSERT INTO attachments (guid, local_path) VALUES (?, ?), (?, ?) `)
      .run('missing-reference-a', PATH, 'missing-reference-b', PATH);

    await expect(
      withDbTransaction(db, (context) => repairMissingActiveAttachmentCacheEntry(context, PATH)),
    ).resolves.toEqual({ clearedReferences: 2 });
    expect(await getAttachmentCacheEntry(db, PATH)).toBeNull();
    expect(
      raw.prepare(`SELECT guid, local_path AS localPath FROM attachments ORDER BY guid`).all(),
    ).toEqual([
      { guid: 'missing-reference-a', localPath: null },
      { guid: 'missing-reference-b', localPath: null },
    ]);
  });

  it('rolls every cleared reference back when missing-file ledger removal fails', async () => {
    const { db, raw } = await createTestDb();
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: PATH, bytes: 50, lastUsedAt: 1_000 }),
    );
    raw
      .prepare(`INSERT INTO attachments (guid, local_path) VALUES (?, ?)`)
      .run('rollback-ref', PATH);
    raw.exec(`
      CREATE TRIGGER reject_missing_cache_repair
      BEFORE DELETE ON attachment_cache_entries
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);

    await expect(
      withDbTransaction(db, (context) => repairMissingActiveAttachmentCacheEntry(context, PATH)),
    ).rejects.toThrow('Attachment cache missing-file repair changed during its transaction');
    expect(await getAttachmentCacheEntry(db, PATH)).toMatchObject({ state: 'active' });
    expect(
      raw
        .prepare(`SELECT local_path AS localPath FROM attachments WHERE guid = ?`)
        .get('rollback-ref'),
    ).toEqual({ localPath: PATH });
  });

  it('caps missing-file repair reference clearing at exactly 1,000 rows', async () => {
    const accepted = await createTestDb();
    const acceptedPath = `${PATH}-missing-reference-limit`;
    await withDbTransaction(accepted.db, (context) =>
      recordAttachmentCacheEntry(context, {
        path: acceptedPath,
        bytes: 10,
        lastUsedAt: 1,
      }),
    );
    seedAttachmentReferences(
      accepted.raw,
      acceptedPath,
      MAX_REFERENCE_CLEAR_ROWS,
      'accepted-missing-reference',
    );

    await expect(
      withDbTransaction(accepted.db, (context) =>
        repairMissingActiveAttachmentCacheEntry(context, acceptedPath),
      ),
    ).resolves.toEqual({ clearedReferences: MAX_REFERENCE_CLEAR_ROWS });
    expect(countAttachmentReferences(accepted.raw, acceptedPath)).toBe(0);
    expect(await getAttachmentCacheEntry(accepted.db, acceptedPath)).toBeNull();

    const refused = await createTestDb();
    const refusedPath = `${PATH}-missing-reference-overflow`;
    await withDbTransaction(refused.db, (context) =>
      recordAttachmentCacheEntry(context, {
        path: refusedPath,
        bytes: 10,
        lastUsedAt: 1,
      }),
    );
    seedAttachmentReferences(
      refused.raw,
      refusedPath,
      MAX_REFERENCE_CLEAR_ROWS + 1,
      'refused-missing-reference',
    );

    await expect(
      withDbTransaction(refused.db, (context) =>
        repairMissingActiveAttachmentCacheEntry(context, refusedPath),
      ),
    ).rejects.toThrow('must not exceed 1000 rows per transaction');
    expect(countAttachmentReferences(refused.raw, refusedPath)).toBe(MAX_REFERENCE_CLEAR_ROWS + 1);
    expect(await getAttachmentCacheEntry(refused.db, refusedPath)).toMatchObject({
      bytes: 10,
      lastUsedAt: 1,
      state: 'active',
    });
  });

  it('counts a shared physical path once even when two attachment rows reference it', async () => {
    const { db, raw } = await createTestDb();
    raw
      .prepare(`INSERT INTO attachments (guid, local_path) VALUES (?, ?), (?, ?)`)
      .run('attachment-a', PATH, 'attachment-b', PATH);

    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: PATH, bytes: 80, lastUsedAt: 100 }),
    );
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: PATH, bytes: 80, lastUsedAt: 200 }),
    );

    expect(
      raw.prepare('SELECT COUNT(*) AS count FROM attachments WHERE local_path = ?').get(PATH),
    ).toEqual({ count: 2 });
    expect(await getAttachmentCacheUsage(db)).toEqual({ files: 1, bytes: 80 });
  });

  it('keeps retirement sticky and durable until deletion is confirmed', async () => {
    const { db } = await createTestDb();
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: PATH, bytes: 75, lastUsedAt: 100 }),
    );
    // An active entry cannot be removed by a stale delete completion.
    expect(
      await withDbTransaction(db, (context) => confirmAttachmentCacheEntryDeleted(context, PATH)),
    ).toBe(false);

    expect(
      await withDbTransaction(db, (context) =>
        claimAttachmentCachePathsForRetirement(context, [PATH]),
      ),
    ).toEqual({ status: 'claimed', paths: [PATH], clearedReferences: 0 });
    expect(
      await withDbTransaction(db, (context) =>
        claimAttachmentCachePathsForRetirement(context, [PATH]),
      ),
    ).toEqual({ status: 'refused', reason: 'not_active', paths: [PATH] });
    // A late download completion cannot resurrect a path while native deletion may own it.
    expect(
      await withDbTransaction(db, (context) =>
        recordAttachmentCacheEntry(context, { path: PATH, bytes: 90, lastUsedAt: 200 }),
      ),
    ).toBe(false);
    expect(await getAttachmentCacheUsage(db)).toEqual({ files: 1, bytes: 75 });

    expect(
      await withDbTransaction(db, (context) =>
        scheduleAttachmentCacheRetirementRetry(context, PATH, 500),
      ),
    ).toEqual({
      attempts: 1,
      nextRetryAt: 5_500,
    });
    expect(await listDueAttachmentCacheRetirements(db, 5_499)).toEqual([]);
    expect(await listDueAttachmentCacheRetirements(db, 5_500)).toEqual([
      {
        path: PATH,
        bytes: 75,
        lastUsedAt: 100,
        state: 'retiring',
        attempts: 1,
        nextRetryAt: 5_500,
      },
    ]);

    expect(
      await withDbTransaction(db, (context) => confirmAttachmentCacheEntryDeleted(context, PATH)),
    ).toBe(true);
    expect(
      await withDbTransaction(db, (context) => confirmAttachmentCacheEntryDeleted(context, PATH)),
    ).toBe(false);
    expect(await getAttachmentCacheEntry(db, PATH)).toBeNull();
    expect(await getAttachmentCacheUsage(db)).toEqual({ files: 0, bytes: 0 });
  });

  it('returns one deterministic bounded usage/candidate snapshot', async () => {
    const { db } = await createTestDb();
    const newer = 'file:///documents/attachments/z/new.jpg';
    const tiedB = 'file:///documents/attachments/b/tied.jpg';
    const tiedA = 'file:///documents/attachments/a/tied.jpg';
    const retiring = 'file:///documents/attachments/r/retiring.jpg';
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: newer, bytes: 40, lastUsedAt: 300 }),
    );
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: tiedB, bytes: 20, lastUsedAt: 100 }),
    );
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: tiedA, bytes: 10, lastUsedAt: 100 }),
    );
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: retiring, bytes: 30, lastUsedAt: 50 }),
    );
    await withDbTransaction(db, (context) =>
      claimAttachmentCachePathsForRetirement(context, [retiring]),
    );

    expect(await getAttachmentCacheQuotaSnapshot(db, 2)).toEqual({
      usage: { files: 4, bytes: 100 },
      candidates: [
        { path: tiedA, bytes: 10, lastUsedAt: 100 },
        { path: tiedB, bytes: 20, lastUsedAt: 100 },
      ],
      hasMoreActive: true,
    });
    expect(await getAttachmentCacheQuotaSnapshot(db, 0)).toEqual({
      usage: { files: 4, bytes: 100 },
      candidates: [],
      hasMoreActive: true,
    });
  });

  it('claims an exact batch and clears every duplicate attachment reference in the outer transaction', async () => {
    const { db, raw } = await createTestDb();
    const second = 'file:///documents/attachments/b/file.jpg';
    const untouched = 'file:///documents/attachments/c/file.jpg';
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: PATH, bytes: 50, lastUsedAt: 1 }),
    );
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: second, bytes: 60, lastUsedAt: 2 }),
    );
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: untouched, bytes: 70, lastUsedAt: 3 }),
    );
    raw
      .prepare(
        `INSERT INTO attachments (guid, local_path) VALUES
           ('normal-a', ?), ('normal-a-duplicate', ?), ('normal-b', ?), ('normal-c', ?)`,
      )
      .run(PATH, PATH, second, untouched);

    const result = await withDbTransaction(db, (context) =>
      claimAttachmentCachePathsForRetirement(context, [second, PATH]),
    );

    expect(result).toEqual({
      status: 'claimed',
      paths: [PATH, second],
      clearedReferences: 3,
    });
    expect(
      raw.prepare('SELECT guid, local_path AS localPath FROM attachments ORDER BY guid').all(),
    ).toEqual([
      { guid: 'normal-a', localPath: null },
      { guid: 'normal-a-duplicate', localPath: null },
      { guid: 'normal-b', localPath: null },
      { guid: 'normal-c', localPath: untouched },
    ]);
    expect(await getAttachmentCacheEntry(db, PATH)).toMatchObject({ state: 'retiring' });
    expect(await getAttachmentCacheEntry(db, second)).toMatchObject({ state: 'retiring' });
    expect(await getAttachmentCacheEntry(db, untouched)).toMatchObject({ state: 'active' });
  });

  it('leaves a shared path active until its final live message reference is tombstoned', async () => {
    const { db, raw } = await createTestDb();
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: PATH, bytes: 50, lastUsedAt: 1 }),
    );
    raw.prepare(`INSERT INTO chats (guid) VALUES ('deleted-cache-chat')`).run();
    const chat = raw.prepare(`SELECT id FROM chats WHERE guid = 'deleted-cache-chat'`).get() as {
      id: number;
    };
    raw
      .prepare(
        `INSERT INTO messages (guid, chat_id, date_created)
         VALUES ('deleted-cache-message', ?, 1), ('live-cache-message', ?, 2)`,
      )
      .run(chat.id, chat.id);
    const deletedMessage = raw
      .prepare(`SELECT id FROM messages WHERE guid = 'deleted-cache-message'`)
      .get() as { id: number };
    const liveMessage = raw
      .prepare(`SELECT id FROM messages WHERE guid = 'live-cache-message'`)
      .get() as { id: number };
    raw
      .prepare(
        `INSERT INTO attachments (guid, message_id, local_path)
         VALUES ('deleted-cache-attachment', ?, ?), ('live-cache-attachment', ?, ?)`,
      )
      .run(deletedMessage.id, PATH, liveMessage.id, PATH);

    await deleteMessageLocal(db, 'deleted-cache-message', 500);

    expect(
      raw
        .prepare(`SELECT date_deleted AS dateDeleted FROM messages WHERE id = ?`)
        .get(deletedMessage.id),
    ).toEqual({ dateDeleted: 500 });
    expect(
      raw
        .prepare(`SELECT local_path AS localPath FROM attachments WHERE message_id = ?`)
        .get(deletedMessage.id),
    ).toEqual({ localPath: PATH });
    expect(await getAttachmentCacheEntry(db, PATH)).toMatchObject({ state: 'active' });
    expect(await listInactiveAttachmentCachePaths(db)).toEqual([]);

    await deleteMessageLocal(db, 'live-cache-message', 600);

    // Tombstones never race native work themselves. They leave the still-accounted path and both
    // references intact; the pin-aware coordinator may now claim it because no live message remains.
    expect(await listInactiveAttachmentCachePaths(db)).toEqual([PATH]);
    expect(
      raw.prepare(`SELECT guid, local_path AS localPath FROM attachments ORDER BY guid`).all(),
    ).toEqual([
      { guid: 'deleted-cache-attachment', localPath: PATH },
      { guid: 'live-cache-attachment', localPath: PATH },
    ]);
    expect(await getAttachmentCacheEntry(db, PATH)).toMatchObject({ state: 'active' });
  });

  it('uses the same retraction and chat-tombstone visibility rules as cache-path writes', async () => {
    const { db, raw } = await createTestDb();
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: PATH, bytes: 50, lastUsedAt: 1 }),
    );
    raw.prepare(`INSERT INTO chats (guid, deleted_at) VALUES ('hidden-cache-chat', 100)`).run();
    const chat = raw.prepare(`SELECT id FROM chats WHERE guid = 'hidden-cache-chat'`).get() as {
      id: number;
    };
    raw
      .prepare(
        `INSERT INTO messages (guid, chat_id, date_created)
         VALUES ('pre-delete-cache-message', ?, 50), ('post-delete-cache-message', ?, 101)`,
      )
      .run(chat.id, chat.id);
    const oldMessage = raw
      .prepare(`SELECT id FROM messages WHERE guid = 'pre-delete-cache-message'`)
      .get() as { id: number };
    const newMessage = raw
      .prepare(`SELECT id FROM messages WHERE guid = 'post-delete-cache-message'`)
      .get() as { id: number };
    raw
      .prepare(
        `INSERT INTO attachments (guid, message_id, local_path)
         VALUES ('pre-delete-cache-attachment', ?, ?), ('post-delete-cache-attachment', ?, ?)`,
      )
      .run(oldMessage.id, PATH, newMessage.id, PATH);

    // The one post-delete message makes the shared path visible and therefore live.
    expect(await listInactiveAttachmentCachePaths(db)).toEqual([]);

    // Once that message is retracted, only the pre-delete hidden reference remains.
    raw.prepare(`UPDATE messages SET date_retracted = 200 WHERE id = ?`).run(newMessage.id);
    expect(await listInactiveAttachmentCachePaths(db)).toEqual([PATH]);
  });

  it('refuses the whole exact batch when any requested path is not active', async () => {
    const { db, raw } = await createTestDb();
    const missing = 'file:///documents/attachments/missing/file.jpg';
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: PATH, bytes: 50, lastUsedAt: 1 }),
    );
    raw.prepare(`INSERT INTO attachments (guid, local_path) VALUES ('normal', ?)`).run(PATH);

    expect(
      await withDbTransaction(db, (context) =>
        claimAttachmentCachePathsForRetirement(context, [PATH, missing]),
      ),
    ).toEqual({ status: 'refused', reason: 'not_active', paths: [missing] });
    expect(await getAttachmentCacheEntry(db, PATH)).toMatchObject({ state: 'active' });
    expect(
      raw.prepare('SELECT local_path AS localPath FROM attachments WHERE guid = ?').get('normal'),
    ).toEqual({ localPath: PATH });
  });

  it('protects a queued payload fallback even when no attachment row references it', async () => {
    const { db, raw } = await createTestDb();
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: PATH, bytes: 50, lastUsedAt: 1 }),
    );
    raw
      .prepare(
        `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
         VALUES ('temp-queued', 'chat', 'attachment', ?)`,
      )
      .run(JSON.stringify({ attachmentGuid: 'missing-att', localPath: PATH }));

    expect(
      await withDbTransaction(db, (context) =>
        claimAttachmentCachePathsForRetirement(context, [PATH]),
      ),
    ).toEqual({ status: 'refused', reason: 'outgoing_protected', paths: [PATH] });
    expect(await getAttachmentCacheEntry(db, PATH)).toMatchObject({ state: 'active' });
  });

  it('protects the current attachment path selected by a queued attachment guid', async () => {
    const { db, raw } = await createTestDb();
    const staleFallback = 'file:///documents/attachments/stale/file.jpg';
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: PATH, bytes: 50, lastUsedAt: 1 }),
    );
    raw.prepare(`INSERT INTO attachments (guid, local_path) VALUES ('queued-att', ?) `).run(PATH);
    raw
      .prepare(
        `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
         VALUES ('temp-queued', 'chat', 'attachment', ?)`,
      )
      .run(JSON.stringify({ attachmentGuid: 'queued-att', localPath: staleFallback }));

    expect(
      await withDbTransaction(db, (context) =>
        claimAttachmentCachePathsForRetirement(context, [PATH]),
      ),
    ).toEqual({ status: 'refused', reason: 'outgoing_protected', paths: [PATH] });
    expect(
      raw
        .prepare(`SELECT local_path AS localPath FROM attachments WHERE guid = 'queued-att'`)
        .get(),
    ).toEqual({ localPath: PATH });
  });

  it('protects a sent temp attachment that a delayed server error can requeue', async () => {
    const { db, raw } = await createTestDb();
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: PATH, bytes: 50, lastUsedAt: 1 }),
    );
    raw.prepare(`INSERT INTO chats (guid) VALUES ('chat-retry')`).run();
    const chat = raw.prepare(`SELECT id FROM chats WHERE guid = 'chat-retry'`).get() as {
      id: number;
    };
    raw
      .prepare(
        `INSERT INTO messages (guid, chat_id, is_from_me, send_state, date_created)
         VALUES ('temp-retry', ?, 1, 'sent', 1)`,
      )
      .run(chat.id);
    const message = raw.prepare(`SELECT id FROM messages WHERE guid = 'temp-retry'`).get() as {
      id: number;
    };
    raw
      .prepare(`INSERT INTO attachments (guid, message_id, local_path) VALUES ('retry-att', ?, ?) `)
      .run(message.id, PATH);

    expect(
      await withDbTransaction(db, (context) =>
        claimAttachmentCachePathsForRetirement(context, [PATH]),
      ),
    ).toEqual({ status: 'refused', reason: 'outgoing_protected', paths: [PATH] });
    expect(
      raw.prepare(`SELECT local_path AS localPath FROM attachments WHERE guid = 'retry-att'`).get(),
    ).toEqual({ localPath: PATH });
  });

  it('fails closed on malformed or oversized attachment queue payloads', async () => {
    const { db, raw } = await createTestDb();
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: PATH, bytes: 50, lastUsedAt: 1 }),
    );
    raw
      .prepare(
        `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
         VALUES ('temp-malformed', 'chat', 'attachment', '{')`,
      )
      .run();
    expect(
      await withDbTransaction(db, (context) =>
        claimAttachmentCachePathsForRetirement(context, [PATH]),
      ),
    ).toEqual({ status: 'refused', reason: 'outgoing_scan_incomplete', paths: [PATH] });
    raw.prepare(`DELETE FROM outgoing_queue`).run();
    raw
      .prepare(
        `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
         VALUES ('temp-oversized', 'chat', 'attachment', ?)`,
      )
      .run(JSON.stringify({ localPath: 'x'.repeat(8200) }));
    expect(
      await withDbTransaction(db, (context) =>
        claimAttachmentCachePathsForRetirement(context, [PATH]),
      ),
    ).toEqual({ status: 'refused', reason: 'outgoing_scan_incomplete', paths: [PATH] });
    expect(await getAttachmentCacheEntry(db, PATH)).toMatchObject({ state: 'active' });
  });

  it('fails closed when outgoing protection or duplicate-reference work exceeds its hard bounds', async () => {
    const queueDb = await createTestDb();
    await withDbTransaction(queueDb.db, (context) =>
      recordAttachmentCacheEntry(context, { path: PATH, bytes: 50, lastUsedAt: 1 }),
    );
    const insertQueue = queueDb.raw.prepare(
      `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
       VALUES (?, 'chat', 'attachment', ?)`,
    );
    queueDb.raw.transaction(() => {
      for (let index = 0; index < 1001; index += 1) {
        insertQueue.run(
          `temp-${index}`,
          JSON.stringify({ attachmentGuid: `att-${index}`, localPath: `file:///other/${index}` }),
        );
      }
    })();
    expect(
      await withDbTransaction(queueDb.db, (context) =>
        claimAttachmentCachePathsForRetirement(context, [PATH]),
      ),
    ).toEqual({ status: 'refused', reason: 'outgoing_scan_incomplete', paths: [PATH] });

    const referenceDb = await createTestDb();
    await withDbTransaction(referenceDb.db, (context) =>
      recordAttachmentCacheEntry(context, { path: PATH, bytes: 50, lastUsedAt: 1 }),
    );
    const insertReference = referenceDb.raw.prepare(
      `INSERT INTO attachments (guid, local_path) VALUES (?, ?)`,
    );
    referenceDb.raw.transaction(() => {
      for (let index = 0; index < 1001; index += 1) {
        insertReference.run(`duplicate-${index}`, PATH);
      }
    })();
    expect(
      await withDbTransaction(referenceDb.db, (context) =>
        claimAttachmentCachePathsForRetirement(context, [PATH]),
      ),
    ).toEqual({ status: 'refused', reason: 'too_many_references', paths: [PATH] });
    expect(await getAttachmentCacheEntry(referenceDb.db, PATH)).toMatchObject({ state: 'active' });
    expect(
      referenceDb.raw
        .prepare('SELECT COUNT(*) AS count FROM attachments WHERE local_path = ?')
        .get(PATH),
    ).toEqual({ count: 1001 });
  });

  it('rolls both ledger claim and reference clear back with its outer transaction', async () => {
    const { db, raw } = await createTestDb();
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: PATH, bytes: 50, lastUsedAt: 1 }),
    );
    raw.prepare(`INSERT INTO attachments (guid, local_path) VALUES ('normal', ?)`).run(PATH);

    await expect(
      withDbTransaction(db, async (context) => {
        expect(await claimAttachmentCachePathsForRetirement(context, [PATH])).toMatchObject({
          status: 'claimed',
        });
        throw new Error('test rollback');
      }),
    ).rejects.toThrow('test rollback');
    expect(await getAttachmentCacheEntry(db, PATH)).toMatchObject({ state: 'active' });
    expect(
      raw.prepare(`SELECT local_path AS localPath FROM attachments WHERE guid = 'normal'`).get(),
    ).toEqual({ localPath: PATH });
  });

  it('persists capped exponential delete retry backoff only for retiring rows', async () => {
    const { db, raw } = await createTestDb();
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: PATH, bytes: 50, lastUsedAt: 1 }),
    );
    expect(
      await withDbTransaction(db, (context) =>
        scheduleAttachmentCacheRetirementRetry(context, PATH, 100),
      ),
    ).toBeNull();
    await withDbTransaction(db, (context) =>
      claimAttachmentCachePathsForRetirement(context, [PATH]),
    );

    expect(attachmentCacheRetirementBackoffMs(1)).toBe(5_000);
    expect(attachmentCacheRetirementBackoffMs(2)).toBe(10_000);
    expect(attachmentCacheRetirementBackoffMs(100)).toBe(ATTACHMENT_CACHE_RETIREMENT_RETRY_MAX_MS);
    expect(
      await withDbTransaction(db, (context) =>
        scheduleAttachmentCacheRetirementRetry(context, PATH, 1_000),
      ),
    ).toEqual({
      attempts: 1,
      nextRetryAt: 6_000,
    });
    expect(
      await withDbTransaction(db, (context) =>
        scheduleAttachmentCacheRetirementRetry(context, PATH, 6_000),
      ),
    ).toEqual({
      attempts: 2,
      nextRetryAt: 16_000,
    });
    raw.prepare(`UPDATE attachment_cache_entries SET attempts = 100 WHERE path = ?`).run(PATH);
    expect(
      await withDbTransaction(db, (context) =>
        scheduleAttachmentCacheRetirementRetry(context, PATH, 10_000),
      ),
    ).toEqual({
      attempts: 101,
      nextRetryAt: 10_000 + ATTACHMENT_CACHE_RETIREMENT_RETRY_MAX_MS,
    });
  });

  it('rejects invalid repository inputs before they reach SQLite', async () => {
    const { db } = await createTestDb();
    await expect(
      withDbTransaction(db, (context) =>
        recordAttachmentCacheEntry(context, { path: '', bytes: 1, lastUsedAt: 1 }),
      ),
    ).rejects.toThrow('path must not be empty');
    await expect(
      withDbTransaction(db, (context) =>
        recordAttachmentCacheEntry(context, {
          path: PATH,
          bytes: Number.MAX_SAFE_INTEGER + 1,
          lastUsedAt: 1,
        }),
      ),
    ).rejects.toThrow('non-negative safe integer');
    await expect(listDueAttachmentCacheRetirements(db, 1, -1)).rejects.toThrow(
      'non-negative safe integer',
    );
    await expect(getAttachmentCacheQuotaSnapshot(db, -1)).rejects.toThrow(
      'non-negative safe integer',
    );
    await expect(
      withDbTransaction(db, (context) =>
        claimAttachmentCachePathsForRetirement(context, [PATH, PATH]),
      ),
    ).rejects.toThrow('must be unique');
    expect(() => attachmentCacheRetirementBackoffMs(0)).toThrow('positive safe integer');
  });
});
