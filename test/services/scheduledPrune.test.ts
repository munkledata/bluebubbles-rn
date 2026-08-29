/**
 * P7 — the Scheduled screen's server reconcile must not prune a row that did not exist when the
 * server built its answer.
 *
 * `GET /scheduled` describes one instant, and the prune runs against the local table as it is when
 * the response lands. Gator has no PUT, so the screen's Edit is delete-then-create: it mints a NEW
 * server id. Do that while the list fetch is in flight and the reconcile deleted the only local
 * handle to a message the server will still fire — the user's edited message goes out with nothing
 * on the Scheduled screen to show for it (and no way to cancel it).
 *
 * The barrel wires native modules at import time, so the native leaves are mocked (composition-root
 * clients / expo uploader / contacts picker); the DB and the reconcile itself are real.
 */
import { Chat } from '@core/models';
import {
  getScheduledById,
  insertScheduled,
  listAllScheduled,
  listServerScheduledPruneExposure,
  reconcileServerScheduled,
  updateScheduled,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/clients', () => ({ http: {} }));
jest.mock('@/services/contacts/contactsService', () => ({ pickContact: jest.fn() }));
jest.mock('@/services/send/attachmentUpload', () => ({
  expoAttachmentUploader: jest.fn(),
  expoFileExists: jest.fn(async () => true),
}));
jest.mock('@/services/send/outgoingPasteOwnership', () => ({
  createOutgoingPasteOwnershipPreparer: jest.fn(),
}));
jest.mock('@ui/toast/toastStore', () => ({ showToast: jest.fn() }));
jest.mock('@core/api/endpoints/scheduled', () => ({
  getScheduled: jest.fn(),
  createScheduled: jest.fn(),
  deleteScheduled: jest.fn(),
}));

// eslint-disable-next-line import/first
import { syncScheduledFromServer } from '@/services/send';
// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';
// eslint-disable-next-line import/first
import { getScheduled } from '@core/api/endpoints/scheduled';

const mockGetScheduled = getScheduled as jest.Mock;

async function seedChat(db: AppDatabase): Promise<void> {
  const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
  await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: [{ address: 'a@b.com' }] })],
    handles,
  );
}

/** The shape `getScheduled` returns for one server-backed row. */
const item = (id: string, text: string) => ({
  id,
  chatGuid: 'c1',
  text,
  scheduledFor: 9_000_000,
  status: 'pending',
});

const serverIdsOf = async (db: AppDatabase): Promise<(string | null)[]> =>
  (await listAllScheduled(db)).map((r) => r.serverId);

/** Native SQLite errors can belong to a prior Jest VM, so match their text without `instanceof`. */
async function expectSqliteRejection(promise: Promise<unknown>, message: RegExp): Promise<void> {
  const outcome = await promise.then(
    () => ({ kind: 'resolved' as const }),
    (error: unknown) => ({ kind: 'rejected' as const, message: String(error) }),
  );
  expect(outcome).toEqual({
    kind: 'rejected',
    message: expect.stringMatching(message),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('syncScheduledFromServer — prune exposure is snapshotted before the round trip', () => {
  it('keeps a row created WHILE the list fetch was in flight', async () => {
    const { db } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    await seedChat(db);
    await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'existing',
      scheduledFor: 9_000_000,
      serverId: 'srv-old',
    });

    // Another server-backed row appears after the request snapshot. It was never exposed to this
    // response, so the response cannot be allowed to prune it.
    mockGetScheduled.mockImplementation(async () => {
      await insertScheduled(db, {
        chatGuid: 'c1',
        text: 'edited mid-fetch',
        scheduledFor: 9_500_000,
        serverId: 'srv-new',
      });
      return [item('srv-old', 'existing')];
    });

    await syncScheduledFromServer();

    const ids = await serverIdsOf(db);
    expect(ids).toContain('srv-new'); // survived the prune
    expect(ids).toContain('srv-old');
  });

  it('does not resurrect a stale server uuid after the same local row is repointed mid-fetch', async () => {
    const { db } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    await seedChat(db);
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'before edit',
      scheduledFor: 9_000_000,
      serverId: 'srv-old',
    });

    // Model a GET whose old response was already built when Edit deletes/re-creates the server
    // message and points the SAME local row at the fresh uuid.
    mockGetScheduled.mockImplementation(async () => {
      await updateScheduled(db, id, {
        text: 'edited mid-fetch',
        scheduledFor: 9_500_000,
        serverId: 'srv-new',
      });
      return [item('srv-old', 'stale response')];
    });

    await syncScheduledFromServer();

    expect(await serverIdsOf(db)).toEqual(['srv-new']);
    expect(await getScheduledById(db, id)).toMatchObject({
      text: 'edited mid-fetch',
      scheduledFor: 9_500_000,
    });
  });

  it('compare-deletes the exposed id and uuid, preserving a row repointed mid-fetch', async () => {
    const { db } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    await seedChat(db);
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'before edit',
      scheduledFor: 9_000_000,
      serverId: 'srv-old',
    });

    mockGetScheduled.mockImplementation(async () => {
      await updateScheduled(db, id, {
        text: 'edited mid-fetch',
        scheduledFor: 9_500_000,
        serverId: 'srv-new',
      });
      return [item('srv-other', 'another server row')];
    });

    await syncScheduledFromServer();

    expect(await serverIdsOf(db)).toEqual(expect.arrayContaining(['srv-new', 'srv-other']));
    expect(await getScheduledById(db, id)).toMatchObject({
      serverId: 'srv-new',
      text: 'edited mid-fetch',
    });
  });

  it('still prunes a row the server dropped that WAS exposed before the fetch', async () => {
    const { db } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    await seedChat(db);
    await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'kept',
      scheduledFor: 9_000_000,
      serverId: 'srv-keep',
    });
    await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'cancelled elsewhere',
      scheduledFor: 9_000_000,
      serverId: 'srv-stale',
    });
    mockGetScheduled.mockResolvedValue([item('srv-keep', 'kept')]);

    await syncScheduledFromServer();

    expect(await serverIdsOf(db)).toEqual(['srv-keep']);
  });

  it('an EMPTY server view still prunes nothing, even with a row created mid-fetch', async () => {
    const { db } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    await seedChat(db);
    await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'existing',
      scheduledFor: 9_000_000,
      serverId: 'srv-old',
    });
    // A transient empty response must never be treated as "the server has nothing" — and the
    // mid-fetch row must not turn that empty keep-set into a non-empty one that prunes the rest.
    mockGetScheduled.mockImplementation(async () => {
      await insertScheduled(db, {
        chatGuid: 'c1',
        text: 'new',
        scheduledFor: 9_500_000,
        serverId: 'srv-new',
      });
      return [];
    });

    await syncScheduledFromServer();

    const ids = await serverIdsOf(db);
    expect(ids).toContain('srv-old');
    expect(ids).toContain('srv-new');
  });

  it('leaves local-only rows alone (they have no server id to be reported)', async () => {
    const { db } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    await seedChat(db);
    await insertScheduled(db, { chatGuid: 'c1', text: 'local only', scheduledFor: 9_000_000 });
    mockGetScheduled.mockResolvedValue([item('srv-x', 'server row')]);

    await syncScheduledFromServer();

    expect(await serverIdsOf(db)).toEqual(expect.arrayContaining([null, 'srv-x']));
  });
});

describe('reconcileServerScheduled — serialized bounded writes', () => {
  it('captures only committed exposure before deciding whether a missing server id is stale', async () => {
    const { db, raw } = await createTestDb();

    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(db, async () => {
      raw
        .prepare(
          `INSERT INTO scheduled_messages
             (server_id, chat_guid, payload, scheduled_for, status)
           VALUES ('srv-phantom', 'c1', '{"text":"phantom"}', 1, 'pending')`,
        )
        .run();
      neighbourStarted();
      await held;
      throw new Error('neighbour rollback');
    });
    await started;

    let captureSettled = false;
    const capture = listServerScheduledPruneExposure(db).then((rows) => {
      captureSettled = true;
      return rows;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledWhileNeighbourHeld = captureSettled;

    releaseNeighbour();
    await expect(neighbour).rejects.toThrow('neighbour rollback');
    const exposure = await capture;
    await reconcileServerScheduled(
      db,
      [
        {
          serverId: 'srv-phantom',
          chatGuid: 'c1',
          text: 'real server row',
          scheduledFor: 10,
          status: 'pending',
        },
      ],
      ['srv-phantom'],
      { pruneExposure: exposure },
    );

    expect(settledWhileNeighbourHeld).toBe(false);
    expect(exposure).toEqual([]);
    expect(await serverIdsOf(db)).toEqual(['srv-phantom']);
  });

  it('queues update, insert, and prune behind a rolling-back neighbour', async () => {
    const { db } = await createTestDb();
    const updateId = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'before update',
      scheduledFor: 1,
      serverId: 'srv-update',
    });
    const staleId = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'stale',
      scheduledFor: 2,
      serverId: 'srv-stale',
    });
    const exposure = await listServerScheduledPruneExposure(db);

    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(db, async () => {
      neighbourStarted();
      await release;
      throw new Error('neighbour rollback');
    });
    await started;

    let updateSettled = false;
    const update = reconcileServerScheduled(
      db,
      [
        {
          serverId: 'srv-update',
          chatGuid: 'c1',
          text: 'after update',
          scheduledFor: 10,
          status: 'pending',
        },
      ],
      ['srv-update'],
      { pruneExposure: exposure.filter((row) => row.id === updateId) },
    ).finally(() => {
      updateSettled = true;
    });
    let insertSettled = false;
    const insert = reconcileServerScheduled(
      db,
      [
        {
          serverId: 'srv-new',
          chatGuid: 'c1',
          text: 'new',
          scheduledFor: 20,
          status: 'pending',
        },
      ],
      ['srv-new'],
      { pruneExposure: [] },
    ).finally(() => {
      insertSettled = true;
    });
    let pruneSettled = false;
    const prune = reconcileServerScheduled(db, [], ['srv-server-view-not-empty'], {
      pruneExposure: exposure.filter((row) => row.id === staleId),
    }).finally(() => {
      pruneSettled = true;
    });
    await Promise.resolve();

    expect({ updateSettled, insertSettled, pruneSettled }).toEqual({
      updateSettled: false,
      insertSettled: false,
      pruneSettled: false,
    });
    expect(await getScheduledById(db, updateId)).toMatchObject({
      text: 'before update',
      scheduledFor: 1,
    });
    expect(await getScheduledById(db, staleId)).not.toBeNull();

    releaseNeighbour();
    await expect(neighbour).rejects.toThrow('neighbour rollback');
    await Promise.all([update, insert, prune]);

    expect(await getScheduledById(db, updateId)).toMatchObject({
      text: 'after update',
      scheduledFor: 10,
    });
    expect(await getScheduledById(db, staleId)).toBeNull();
    expect(await serverIdsOf(db)).toEqual(['srv-update', 'srv-new']);
  });

  it('rejects a queued item transaction when its account commit guard is revoked', async () => {
    const { db } = await createTestDb();
    const exposure = await listServerScheduledPruneExposure(db);

    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(db, async () => {
      neighbourStarted();
      await release;
      throw new Error('neighbour rollback');
    });
    await started;

    let ownsAccount = true;
    const reconcile = reconcileServerScheduled(
      db,
      [
        {
          serverId: 'srv-revoked',
          chatGuid: 'c1',
          text: 'must not commit',
          scheduledFor: 10,
          status: 'pending',
        },
      ],
      ['srv-revoked'],
      { pruneExposure: exposure, commitGuard: () => ownsAccount },
    );
    await Promise.resolve();
    ownsAccount = false;
    releaseNeighbour();

    await expect(neighbour).rejects.toThrow('neighbour rollback');
    await expect(reconcile).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    expect(await listAllScheduled(db)).toEqual([]);
  });

  it('commits earlier exact-pair prunes when a later bounded prune fails, then retries', async () => {
    const { db, raw } = await createTestDb();
    const insert = raw.prepare(
      `INSERT INTO scheduled_messages
         (server_id, chat_guid, payload, scheduled_for, status)
       VALUES (?, 'c1', ?, 1, 'pending')`,
    );
    for (let i = 1; i <= 205; i += 1) {
      insert.run(`srv-${i}`, JSON.stringify({ text: `row-${i}` }));
    }
    const exposure = await listServerScheduledPruneExposure(db);
    raw.exec(`
      CREATE TRIGGER fail_scheduled_prune
      BEFORE DELETE ON scheduled_messages
      WHEN OLD.server_id = 'srv-101'
      BEGIN
        SELECT RAISE(ABORT, 'planned prune failure');
      END
    `);

    await expectSqliteRejection(
      reconcileServerScheduled(db, [], ['srv-server-view-not-empty'], { pruneExposure: exposure }),
      /planned prune failure/,
    );

    expect(
      (raw.prepare('SELECT COUNT(*) AS count FROM scheduled_messages').get() as { count: number })
        .count,
    ).toBe(105);
    expect(
      raw.prepare("SELECT 1 FROM scheduled_messages WHERE server_id = 'srv-100'").get(),
    ).toBeUndefined();
    expect(
      raw.prepare("SELECT 1 FROM scheduled_messages WHERE server_id = 'srv-101'").get(),
    ).toBeDefined();

    raw.exec('DROP TRIGGER fail_scheduled_prune');
    const remainingExposure = await listServerScheduledPruneExposure(db);
    await reconcileServerScheduled(db, [], ['srv-server-view-not-empty'], {
      pruneExposure: remainingExposure,
    });
    expect(await listAllScheduled(db)).toEqual([]);
  });
});
