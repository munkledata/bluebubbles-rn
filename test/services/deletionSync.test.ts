import type Database from 'better-sqlite3';
import { Message } from '@core/models';
import { ApiError } from '@core/api/errors';
import {
  DELETED_MESSAGE_PAGE_LIMIT,
  DeletedMessageList,
  type DeletedMessage,
  type DeletedMessagePage,
} from '@core/api/endpoints/messages';
import {
  kvGet,
  kvSet,
  kvSetWithinTransaction,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import * as kvRepository from '@db/repositories/kv';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  DELETION_SNAPSHOT_INITIALIZED_KEY,
  DELETION_SNAPSHOT_INITIALIZED_VALUE,
  DELETIONS_SYNCED_AT_KEY,
  DeletionSyncIncompleteError,
  DeletionSyncProtocolError,
  isDeletionSnapshotInitialized,
  syncDeletedMessages,
} from '@/services/sync/engine';
import type { SyncApi } from '@/services/sync/types';
import { createTestDb } from '../support/testDb';

/**
 * R1 deletion catch-up sync (engine-level): a `message-deleted` event that fires while the app is
 * dead or app-locked is LOST (the locked FCM path never touches the DB), so syncDeletedMessages
 * pages GET /message/deleted after the persisted watermark and re-applies the tombstones.
 */

function api(fetchDeletedAfter: NonNullable<SyncApi['fetchDeletedAfter']>): SyncApi {
  return {
    serverVersion: async () => '1.9.0',
    fetchChats: async () => [],
    fetchChatMessages: async () => [],
    fetchMessagesAfter: async () => [],
    fetchDeletedAfter,
  };
}

function cursorApi(
  fetchDeletedPage: NonNullable<SyncApi['fetchDeletedPage']>,
  fetchDeletedAfter: NonNullable<SyncApi['fetchDeletedAfter']> = async () => [],
): SyncApi {
  return { ...api(fetchDeletedAfter), fetchDeletedPage };
}

function legacyState(afterMs: number): string {
  return JSON.stringify({ v: 1, mode: 'legacy', afterMs });
}

function cursorState(afterMs: number, cursor: string): string {
  return JSON.stringify({ v: 1, mode: 'cursor', afterMs, cursor });
}

/** Seed a chat + messages through the same upsert path the sync engine uses. */
async function seed(db: AppDatabase, chatGuid: string, guids: string[]): Promise<void> {
  const msgs = guids.map((g, i) =>
    Message.parse({
      guid: g,
      text: g,
      dateCreated: 1700000000000 + i,
      chats: [{ guid: chatGuid, participants: [{ address: 'alice@x.com' }] }],
    }),
  );
  const embedded = msgs.flatMap((m) => m.chats ?? []);
  const handleMap = await upsertHandles(
    db,
    embedded.flatMap((c) => c.participants ?? []),
  );
  const chatMap = await upsertChats(db, embedded, handleMap);
  await upsertMessages(db, msgs, (m) => chatMap.get(m.chats?.[0]?.guid ?? ''), handleMap);
}

/** guid → date_deleted for every stored message (null = not tombstoned). */
function tombstones(raw: Database.Database): Map<string, number | null> {
  const rows = raw.prepare('SELECT guid, date_deleted AS d FROM messages').all() as {
    guid: string;
    d: number | null;
  }[];
  return new Map(rows.map((r) => [r.guid, r.d]));
}

const nextEventLoopTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

async function expectProtocolError(
  promise: Promise<unknown>,
  code: DeletionSyncProtocolError['code'],
): Promise<void> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DeletionSyncProtocolError);
  expect(error).toMatchObject({ code });
  expect((error as Error).message).toBe(`Deletion sync protocol violation: ${code}`);
}

describe('syncDeletedMessages — R1 deletion catch-up', () => {
  it('recognizes only the current versioned stable-snapshot proof', async () => {
    const { db } = await createTestDb();

    await expect(isDeletionSnapshotInitialized(db)).resolves.toBe(false);
    await kvSet(db, DELETION_SNAPSHOT_INITIALIZED_KEY, '{"v":0}');
    await expect(isDeletionSnapshotInitialized(db)).resolves.toBe(false);
    await kvSet(db, DELETION_SNAPSHOT_INITIALIZED_KEY, DELETION_SNAPSHOT_INITIALIZED_VALUE);
    await expect(isDeletionSnapshotInitialized(db)).resolves.toBe(true);
  });

  it('enforces the 500-row server contract at the API schema boundary', () => {
    const row = (index: number): DeletedMessage => ({
      guid: `deleted-${index}`,
      chatGuid: null,
      dateDeleted: index,
    });

    expect(
      DeletedMessageList.parse({
        deleted: Array.from({ length: DELETED_MESSAGE_PAGE_LIMIT }, (_, index) => row(index)),
      }).deleted,
    ).toHaveLength(DELETED_MESSAGE_PAGE_LIMIT);
    expect(() =>
      DeletedMessageList.parse({
        deleted: Array.from({ length: DELETED_MESSAGE_PAGE_LIMIT + 1 }, (_, index) => row(index)),
      }),
    ).toThrow();
    for (const malformed of ['garbage', '', Number.POSITIVE_INFINITY]) {
      expect(
        DeletedMessageList.safeParse({
          deleted: [{ guid: 'malformed-date', chatGuid: null, dateDeleted: malformed }],
        }).success,
      ).toBe(false);
    }
    expect(
      DeletedMessageList.parse({
        deleted: [{ guid: 'numeric-string', chatGuid: null, dateDeleted: '1234' }],
      }).deleted?.[0]?.dateDeleted,
    ).toBe(1234);
    expect(
      DeletedMessageList.safeParse({ deleted: [], cursor: 'cursor-without-has-more' }).success,
    ).toBe(false);
    expect(DeletedMessageList.safeParse({ deleted: [], hasMore: false }).success).toBe(false);
    expect(
      DeletedMessageList.safeParse({ deleted: [], cursor: 'x'.repeat(513), hasMore: false })
        .success,
    ).toBe(false);
    expect(DeletedMessageList.safeParse({ cursor: 'missing-rows', hasMore: true }).success).toBe(
      false,
    );
    expect(
      DeletedMessageList.safeParse({ deleted: null, cursor: 'null-rows', hasMore: true }).success,
    ).toBe(false);
  });

  it('does NOTHING when the capability is unsupported: no fetch and no state', async () => {
    const { db } = await createTestDb();
    const fetch = jest.fn<Promise<DeletedMessage[]>, [number]>(async () => [
      { guid: 'never-applied', chatGuid: null, dateDeleted: 123 },
    ]);

    const applied = await syncDeletedMessages(db, api(fetch), { supported: false });

    expect(applied).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    // No state either — the first supported run owns initialization.
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBeNull();
  });

  it('starts a first run from zero and replays recoverable deletion history without using the device clock', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 'c1', ['m1']);
    const fetch = jest.fn<Promise<DeletedMessage[]>, [number]>(async () => [
      { guid: 'm1', chatGuid: 'c1', dateDeleted: 111 },
    ]);
    const clock = jest.fn(() => 1700000123456);

    const applied = await syncDeletedMessages(db, api(fetch), {
      supported: true,
      now: clock,
    });

    expect(applied).toBe(1);
    expect(fetch).toHaveBeenCalledWith(0, undefined);
    expect(clock).not.toHaveBeenCalled();
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(legacyState(111));
    expect(tombstones(raw).get('m1')).toBe(111);
  });

  it('keeps ordinary catch-up bounded to five pages and returns its partial applied count', async () => {
    const { db } = await createTestDb();
    let page = 0;
    const fetch = jest.fn<Promise<DeletedMessagePage>, [number, string | null, AbortSignal?]>(
      async () => {
        page += 1;
        return {
          protocol: 'continuation',
          deleted: [{ guid: `ordinary-${page}`, chatGuid: null, dateDeleted: page }],
          cursor: `v2.ordinary-${page}`,
          hasMore: true,
        };
      },
    );

    await expect(syncDeletedMessages(db, cursorApi(fetch), { supported: true })).resolves.toBe(5);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(cursorState(5, 'v2.ordinary-5'));
  });

  it('exhaustive catch-up ignores durable state and resolves only after an explicit terminal page', async () => {
    const { db } = await createTestDb();
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, cursorState(9_000, 'v2.persisted'));
    const fetch = jest.fn<Promise<DeletedMessagePage>, [number, string | null, AbortSignal?]>(
      async (_after, cursor) =>
        cursor == null
          ? {
              protocol: 'continuation',
              deleted: [{ guid: 'snapshot-row', chatGuid: null, dateDeleted: 100 }],
              cursor: 'v2.snapshot-page',
              hasMore: true,
            }
          : {
              protocol: 'continuation',
              deleted: [],
              cursor: 'v2.snapshot-terminal',
              hasMore: false,
            },
    );

    await expect(
      syncDeletedMessages(db, cursorApi(fetch), { supported: false, exhaustive: true }),
    ).resolves.toBe(1);
    expect(fetch.mock.calls).toEqual([
      [0, null, undefined],
      [100, 'v2.snapshot-page', undefined],
    ]);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(cursorState(100, 'v2.snapshot-terminal'));
  });

  it('exhaustive catch-up rejects non-ledger protocols before writes and enforces its safety cap', async () => {
    const { db: legacyDb } = await createTestDb();
    const legacy = syncDeletedMessages(
      legacyDb,
      api(async () => []),
      { supported: true, exhaustive: true },
    );
    await expect(legacy).rejects.toMatchObject<Partial<DeletionSyncIncompleteError>>({
      reason: 'legacy-protocol',
    });
    expect(await kvGet(legacyDb, DELETIONS_SYNCED_AT_KEY)).toBeNull();

    const { db: v1Db, raw: v1Raw } = await createTestDb();
    await expect(
      syncDeletedMessages(
        v1Db,
        cursorApi(async () => ({
          protocol: 'continuation',
          deleted: [{ guid: 'must-not-apply-v1', chatGuid: null, dateDeleted: 1 }],
          cursor: 'v1.legacy-cursor',
          hasMore: false,
        })),
        { supported: true, exhaustive: true },
      ),
    ).rejects.toMatchObject<Partial<DeletionSyncIncompleteError>>({
      reason: 'non-ledger-protocol',
    });
    expect(await kvGet(v1Db, DELETIONS_SYNCED_AT_KEY)).toBeNull();
    expect(
      v1Raw
        .prepare('SELECT date_deleted FROM message_deletion_ledger WHERE guid = ?')
        .pluck()
        .get('must-not-apply-v1'),
    ).toBeUndefined();

    const { db: cappedDb } = await createTestDb();
    let page = 0;
    const neverTerminal = jest.fn<
      Promise<DeletedMessagePage>,
      [number, string | null, AbortSignal?]
    >(async () => {
      page += 1;
      return {
        protocol: 'continuation',
        deleted: [{ guid: `capped-${page}`, chatGuid: null, dateDeleted: page }],
        cursor: `v2.capped-${page}`,
        hasMore: true,
      };
    });

    await expect(
      syncDeletedMessages(cappedDb, cursorApi(neverTerminal), {
        supported: true,
        exhaustive: true,
        maxPages: 2,
      }),
    ).rejects.toMatchObject<Partial<DeletionSyncIncompleteError>>({ reason: 'page-cap' });
    expect(neverTerminal).toHaveBeenCalledTimes(2);
    expect(await kvGet(cappedDb, DELETIONS_SYNCED_AT_KEY)).toBe(cursorState(2, 'v2.capped-2'));
  });

  it('replaces an old clock-derived timestamp with cursor pages from zero and persists the terminal cursor', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 'c1', ['cursor-1', 'cursor-2', 'cursor-3']);
    // This is the old format and is years ahead of the deletion rows. Trusting it would skip all
    // three; cursor-aware state deliberately treats it as uninitialized.
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, '4102444800000');
    const fetch = jest.fn<Promise<DeletedMessagePage>, [number, string | null, AbortSignal?]>(
      async (_after, cursor) => {
        if (cursor == null) {
          return {
            protocol: 'continuation',
            deleted: [
              { guid: 'cursor-1', chatGuid: 'c1', dateDeleted: 10.5 },
              { guid: 'cursor-2', chatGuid: 'c1', dateDeleted: 10.5 },
            ],
            cursor: 'page-1',
            hasMore: true,
          };
        }
        if (cursor === 'page-1') {
          return {
            protocol: 'continuation',
            deleted: [{ guid: 'cursor-3', chatGuid: 'c1', dateDeleted: 10.5 }],
            cursor: 'page-2',
            hasMore: true,
          };
        }
        return {
          protocol: 'continuation',
          deleted: [],
          cursor: 'terminal',
          hasMore: false,
        };
      },
    );

    await expect(syncDeletedMessages(db, cursorApi(fetch), { supported: true })).resolves.toBe(3);

    expect(fetch.mock.calls).toEqual([
      [0, null, undefined],
      [10.5, 'page-1', undefined],
      [10.5, 'page-2', undefined],
    ]);
    expect([
      tombstones(raw).get('cursor-1'),
      tombstones(raw).get('cursor-2'),
      tombstones(raw).get('cursor-3'),
    ]).toEqual([10.5, 10.5, 10.5]);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(cursorState(10.5, 'terminal'));

    const resume = jest.fn<Promise<DeletedMessagePage>, [number, string | null, AbortSignal?]>(
      async () => ({
        protocol: 'continuation',
        deleted: [],
        cursor: 'terminal',
        hasMore: false,
      }),
    );
    await expect(syncDeletedMessages(db, cursorApi(resume), { supported: true })).resolves.toBe(0);
    expect(resume).toHaveBeenCalledWith(10.5, 'terminal', undefined);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(cursorState(10.5, 'terminal'));
  });

  it('adopts a returned v2 cursor from persisted v1 state and accepts ledger-ordered dates', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 'c1', ['ledger-old', 'ledger-high', 'ledger-descending']);
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, cursorState(2500, 'v1.start'));
    const fetch = jest.fn<Promise<DeletedMessagePage>, [number, string | null, AbortSignal?]>(
      async () => ({
        protocol: 'continuation',
        deleted: [
          { guid: 'ledger-old', chatGuid: 'c1', dateDeleted: 1000 },
          { guid: 'ledger-high', chatGuid: 'c1', dateDeleted: 4000 },
          { guid: 'ledger-descending', chatGuid: 'c1', dateDeleted: 2000 },
        ],
        cursor: 'v2.next',
        hasMore: false,
      }),
    );

    await expect(syncDeletedMessages(db, cursorApi(fetch), { supported: true })).resolves.toBe(3);

    expect(fetch).toHaveBeenCalledWith(2500, 'v1.start', undefined);
    expect([
      tombstones(raw).get('ledger-old'),
      tombstones(raw).get('ledger-high'),
      tombstones(raw).get('ledger-descending'),
    ]).toEqual([1000, 4000, 2000]);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(cursorState(4000, 'v2.next'));
  });

  it.each(['legacy', 'v1'] as const)(
    'replays from zero after an old server rejects a persisted v2 cursor, then adopts %s state atomically',
    async (recoveredProtocol) => {
      const { db, raw } = await createTestDb();
      await seed(db, 'c1', ['downgrade-replay']);
      const originalState = cursorState(3000, 'v2.persisted');
      await kvSet(db, DELETIONS_SYNCED_AT_KEY, originalState);
      let call = 0;
      const fetch = jest.fn<Promise<DeletedMessagePage>, [number, string | null, AbortSignal?]>(
        async () => {
          call++;
          if (call === 1) {
            throw new ApiError('bad_request', 'GET /message/deleted failed', 400);
          }

          // The failed probe never persists a naked reset. Until this page commits, the previous
          // account-scoped cursor remains the durable retry point.
          expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(originalState);
          if (recoveredProtocol === 'legacy') {
            return {
              protocol: 'legacy',
              deleted: [{ guid: 'downgrade-replay', chatGuid: 'c1', dateDeleted: 1000 }],
            };
          }
          return {
            protocol: 'continuation',
            deleted: [{ guid: 'downgrade-replay', chatGuid: 'c1', dateDeleted: 1000 }],
            cursor: 'v1.recovered',
            hasMore: false,
          };
        },
      );

      await expect(syncDeletedMessages(db, cursorApi(fetch), { supported: true })).resolves.toBe(1);

      expect(fetch.mock.calls).toEqual([
        [3000, 'v2.persisted', undefined],
        [0, null, undefined],
      ]);
      expect(tombstones(raw).get('downgrade-replay')).toBe(1000);
      expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(
        recoveredProtocol === 'legacy' ? legacyState(1000) : cursorState(1000, 'v1.recovered'),
      );
    },
  );

  it('retries a rejected persisted v2 cursor only once', async () => {
    const { db } = await createTestDb();
    const originalState = cursorState(3000, 'v2.persisted');
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, originalState);
    const rejection = new ApiError('bad_request', 'GET /message/deleted failed', 400);
    const fetch = jest.fn<Promise<DeletedMessagePage>, [number, string | null, AbortSignal?]>(
      async () => {
        throw rejection;
      },
    );

    await expect(syncDeletedMessages(db, cursorApi(fetch), { supported: true })).rejects.toBe(
      rejection,
    );

    expect(fetch.mock.calls).toEqual([
      [3000, 'v2.persisted', undefined],
      [0, null, undefined],
    ]);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(originalState);
  });

  it('does not reinterpret a rejected v1 cursor as an old-server downgrade', async () => {
    const { db } = await createTestDb();
    const originalState = cursorState(3000, 'v1.persisted');
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, originalState);
    const rejection = new ApiError('bad_request', 'GET /message/deleted failed', 400);
    const fetch = jest.fn<Promise<DeletedMessagePage>, [number, string | null, AbortSignal?]>(
      async () => {
        throw rejection;
      },
    );

    await expect(syncDeletedMessages(db, cursorApi(fetch), { supported: true })).rejects.toBe(
      rejection,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(3000, 'v1.persisted', undefined);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(originalState);
  });

  it.each([
    ['network', new ApiError('no_connection', 'offline')],
    ['server', new ApiError('server_error', 'unavailable', 503)],
  ] as const)(
    'does not reset a persisted v2 cursor after an arbitrary %s failure',
    async (_name, error) => {
      const { db } = await createTestDb();
      const originalState = cursorState(3000, 'v2.persisted');
      await kvSet(db, DELETIONS_SYNCED_AT_KEY, originalState);
      const fetch = jest.fn<Promise<DeletedMessagePage>, [number, string | null, AbortSignal?]>(
        async () => {
          throw error;
        },
      );

      await expect(syncDeletedMessages(db, cursorApi(fetch), { supported: true })).rejects.toBe(
        error,
      );

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(3000, 'v2.persisted', undefined);
      expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(originalState);
    },
  );

  it('does not begin v2 downgrade recovery after account ownership is revoked', async () => {
    const { db } = await createTestDb();
    const originalState = cursorState(3000, 'v2.persisted');
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, originalState);
    let aborted = false;
    const fetch = jest.fn<Promise<DeletedMessagePage>, [number, string | null, AbortSignal?]>(
      async () => {
        aborted = true;
        throw new ApiError('bad_request', 'GET /message/deleted failed', 400);
      },
    );

    await expect(
      syncDeletedMessages(db, cursorApi(fetch), {
        supported: true,
        shouldAbort: () => aborted,
      }),
    ).resolves.toBe(0);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(3000, 'v2.persisted', undefined);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(originalState);
  });

  it.each([
    {
      name: 'a timestamp older than the requested watermark',
      code: 'timestamp-before-watermark' as const,
      rows: [
        { guid: 'v1-before-first', chatGuid: 'c1', dateDeleted: 2000 },
        { guid: 'v1-before-second', chatGuid: 'c1', dateDeleted: 999 },
      ] satisfies DeletedMessage[],
    },
    {
      name: 'decreasing timestamps',
      code: 'timestamp-out-of-order' as const,
      rows: [
        { guid: 'v1-order-first', chatGuid: 'c1', dateDeleted: 3000 },
        { guid: 'v1-order-second', chatGuid: 'c1', dateDeleted: 2000 },
      ] satisfies DeletedMessage[],
    },
  ])('retains strict validation for v1 continuation pages with $name', async ({ code, rows }) => {
    const { db, raw } = await createTestDb();
    const guids = rows.map((row) => row.guid);
    await seed(db, 'c1', guids);
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, cursorState(1000, 'v1.start'));

    await expectProtocolError(
      syncDeletedMessages(
        db,
        cursorApi(async () => ({
          protocol: 'continuation',
          deleted: rows,
          cursor: 'v1.next',
          hasMore: false,
        })),
        { supported: true },
      ),
      code,
    );

    expect(guids.map((guid) => tombstones(raw).get(guid))).toEqual(guids.map(() => null));
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(cursorState(1000, 'v1.start'));
  });

  it('restarts once from zero when a legacy state first encounters a cursor-capable server', async () => {
    const { db, raw } = await createTestDb();
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, legacyState(1000));
    const fetch = jest.fn<Promise<DeletedMessagePage>, [number, string | null, AbortSignal?]>(
      async (after) =>
        after === 1000
          ? {
              protocol: 'continuation',
              deleted: [{ guid: 'discarded-upgrade-probe', chatGuid: null, dateDeleted: 1500 }],
              cursor: 'unsafe-conversion',
              hasMore: false,
            }
          : {
              protocol: 'continuation',
              deleted: [{ guid: 'zero-origin-row', chatGuid: 'c1', dateDeleted: 100 }],
              cursor: 'zero-terminal',
              hasMore: false,
            },
    );

    await expect(syncDeletedMessages(db, cursorApi(fetch), { supported: true })).resolves.toBe(1);

    expect(fetch.mock.calls).toEqual([
      [1000, null, undefined],
      [0, null, undefined],
    ]);
    expect(
      raw
        .prepare('SELECT date_deleted FROM message_deletion_ledger WHERE guid = ?')
        .pluck()
        .get('discarded-upgrade-probe'),
    ).toBeUndefined();
    expect(
      raw
        .prepare('SELECT date_deleted FROM message_deletion_ledger WHERE guid = ?')
        .pluck()
        .get('zero-origin-row'),
    ).toBe(100);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(cursorState(100, 'zero-terminal'));
  });

  it.each([true, false])(
    'rejects a non-advancing continuation with rows before writing its page (hasMore=$hasMore)',
    async (hasMore) => {
      const { db, raw } = await createTestDb();
      await kvSet(db, DELETIONS_SYNCED_AT_KEY, cursorState(100, 'stuck'));

      await expectProtocolError(
        syncDeletedMessages(
          db,
          cursorApi(async () => ({
            protocol: 'continuation',
            deleted: [{ guid: 'must-not-commit', chatGuid: null, dateDeleted: 200 }],
            cursor: 'stuck',
            hasMore,
          })),
          { supported: true },
        ),
        'cursor-not-advanced',
      );

      expect(
        raw
          .prepare('SELECT date_deleted FROM message_deletion_ledger WHERE guid = ?')
          .pluck()
          .get('must-not-commit'),
      ).toBeUndefined();
      expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(cursorState(100, 'stuck'));
    },
  );

  it('reads committed state after a rolling-back neighbour, then initializes from zero', async () => {
    const { db } = await createTestDb();
    const fetch = jest.fn<Promise<DeletedMessage[]>, [number]>(async () => []);
    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(db, async (context) => {
      await kvSetWithinTransaction(context, DELETIONS_SYNCED_AT_KEY, '9999');
      neighbourStarted();
      await release;
      throw new Error('neighbour rollback');
    });
    await started;

    let settled = false;
    const sync = syncDeletedMessages(db, api(fetch), {
      supported: true,
      now: () => 1234,
    }).finally(() => {
      settled = true;
    });
    await nextEventLoopTurn();

    expect(settled).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    releaseNeighbour();
    await expect(neighbour).rejects.toThrow('neighbour rollback');
    await expect(sync).resolves.toBe(0);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(legacyState(0));
    expect(fetch).toHaveBeenCalledWith(0, undefined);
  });

  it('rejects a queued first-run state read after account ownership is revoked', async () => {
    const { db } = await createTestDb();
    const fetch = jest.fn<Promise<DeletedMessage[]>, [number]>(async () => []);
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

    let aborted = false;
    const sync = syncDeletedMessages(db, api(fetch), {
      supported: true,
      now: () => 1234,
      shouldAbort: () => aborted,
    });
    const rejected = expect(sync).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    await nextEventLoopTurn();
    aborted = true;
    releaseNeighbour();

    await expect(neighbour).rejects.toThrow('neighbour rollback');
    await rejected;
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps network outside the mutex and rejects its queued tombstone after ownership changes', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 'c1', ['m1']);
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, legacyState(1000));

    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    let neighbour!: Promise<never>;
    const fetch = jest.fn<Promise<DeletedMessage[]>, [number]>(async () => {
      // This transaction can acquire while the request is active only if deletion sync released
      // its initial watermark lock before starting network I/O.
      neighbour = withDbTransaction(db, async () => {
        neighbourStarted();
        await release;
        throw new Error('neighbour rollback');
      });
      await started;
      return [{ guid: 'm1', chatGuid: 'c1', dateDeleted: 2000 }];
    });

    let aborted = false;
    const sync = syncDeletedMessages(db, api(fetch), {
      supported: true,
      shouldAbort: () => aborted,
    });
    const rejected = expect(sync).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    await started;
    await nextEventLoopTurn();
    aborted = true;
    releaseNeighbour();

    await expect(neighbour).rejects.toThrow('neighbour rollback');
    await rejected;
    expect(tombstones(raw).get('m1')).toBeNull();
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(legacyState(1000));
  });

  it('rolls back the whole page when account ownership is revoked before commit', async () => {
    const { db, raw } = await createTestDb();
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, legacyState(1000));
    let releaseStateWrite!: () => void;
    let markStateWriteStarted!: () => void;
    const stateWriteStarted = new Promise<void>((resolve) => {
      markStateWriteStarted = resolve;
    });
    const stateWriteHeld = new Promise<void>((resolve) => {
      releaseStateWrite = resolve;
    });
    const realKvSetWithinTransaction = kvRepository.kvSetWithinTransaction;
    const stateWriteSpy = jest
      .spyOn(kvRepository, 'kvSetWithinTransaction')
      .mockImplementation(async (context, key, value) => {
        if (key === DELETIONS_SYNCED_AT_KEY && value === legacyState(2000)) {
          markStateWriteStarted();
          await stateWriteHeld;
        }
        await realKvSetWithinTransaction(context, key, value);
      });
    let aborted = false;
    const sync = syncDeletedMessages(
      db,
      api(async () => [{ guid: 'cursor-revoked', chatGuid: null, dateDeleted: 2000 }]),
      { supported: true, shouldAbort: () => aborted },
    );
    try {
      await stateWriteStarted;
      aborted = true;
      releaseStateWrite();
      await expect(sync).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    } finally {
      releaseStateWrite();
      await Promise.allSettled([sync]);
      stateWriteSpy.mockRestore();
    }
    expect(
      raw
        .prepare('SELECT date_deleted FROM message_deletion_ledger WHERE guid = ?')
        .pluck()
        .get('cursor-revoked'),
    ).toBeUndefined();
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(legacyState(1000));
  });

  it('rolls back tombstones with a failed state write and releases retry', async () => {
    const { db, raw } = await createTestDb();
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, legacyState(1000));
    raw.exec(`
      CREATE TRIGGER reject_deletion_cursor
      BEFORE UPDATE OF value ON kv
      WHEN OLD.key = '${DELETIONS_SYNCED_AT_KEY}'
      BEGIN
        SELECT RAISE(ABORT, 'DELETION_CURSOR_RAW_CANARY');
      END
    `);
    const fetch = jest.fn<Promise<DeletedMessage[]>, [number]>(async () => [
      { guid: 'cursor-failure', chatGuid: null, dateDeleted: 2000 },
    ]);

    await expect(syncDeletedMessages(db, api(fetch), { supported: true })).rejects.toMatchObject({
      message: 'DELETION_CURSOR_RAW_CANARY',
    });
    expect(
      raw
        .prepare('SELECT date_deleted FROM message_deletion_ledger WHERE guid = ?')
        .pluck()
        .get('cursor-failure'),
    ).toBeUndefined();
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(legacyState(1000));

    raw.exec('DROP TRIGGER reject_deletion_cursor');
    await expect(syncDeletedMessages(db, api(fetch), { supported: true })).resolves.toBe(1);
    expect(fetch.mock.calls).toEqual([
      [1000, undefined],
      [1000, undefined],
    ]);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(legacyState(2000));
  });

  it('awaits the asynchronous cursor body before committing its transaction owner', async () => {
    const { db, raw } = await createTestDb();
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, legacyState(1000));

    let releaseCursorWrite!: () => void;
    let markCursorWriteFinished!: () => void;
    const cursorWriteHeld = new Promise<void>((resolve) => {
      releaseCursorWrite = resolve;
    });
    const cursorWriteFinished = new Promise<void>((resolve) => {
      markCursorWriteFinished = resolve;
    });
    const realKvSetWithinTransaction = kvRepository.kvSetWithinTransaction;
    let cursorWriteDidStart = false;
    const cursorWriteSpy = jest
      .spyOn(kvRepository, 'kvSetWithinTransaction')
      .mockImplementation(async (context, key, value) => {
        if (key === DELETIONS_SYNCED_AT_KEY && value === legacyState(2000)) {
          cursorWriteDidStart = true;
          try {
            await cursorWriteHeld;
            await realKvSetWithinTransaction(context, key, value);
          } finally {
            markCursorWriteFinished();
          }
          return;
        }
        await realKvSetWithinTransaction(context, key, value);
      });

    let syncSettled = false;
    const syncOutcome = syncDeletedMessages(
      db,
      api(async () => [{ guid: 'cursor-delayed-driver', chatGuid: null, dateDeleted: 2000 }]),
      { supported: true },
    )
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        syncSettled = true;
      });

    try {
      for (let turn = 0; turn < 20 && !cursorWriteDidStart; turn += 1) {
        await nextEventLoopTurn();
      }
      if (!cursorWriteDidStart) {
        throw new Error('deletion cursor write did not start within 20 event-loop turns');
      }

      let observationError: unknown;
      try {
        await nextEventLoopTurn();
        expect(syncSettled).toBe(false);
        expect(raw.inTransaction).toBe(true);
        expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(legacyState(1000));
      } catch (error) {
        observationError = error;
      } finally {
        releaseCursorWrite();
      }

      const [outcome] = await Promise.all([syncOutcome, cursorWriteFinished]);
      if (observationError) throw observationError;
      expect(outcome).toEqual({ kind: 'resolved', value: 1 });
      expect(raw.inTransaction).toBe(false);
      expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(legacyState(2000));
    } finally {
      releaseCursorWrite();
      try {
        if (cursorWriteDidStart) {
          await Promise.allSettled([syncOutcome, cursorWriteFinished]);
        }
      } finally {
        cursorWriteSpy.mockRestore();
      }
    }
  });

  it('applies deletions after the watermark, durably records unknown guids, and advances it', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 'c1', ['m1', 'm2']);
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, legacyState(1000));

    const fetch = jest.fn<Promise<DeletedMessage[]>, [number]>(async (after) =>
      after === 1000
        ? [
            { guid: 'm1', chatGuid: 'c1', dateDeleted: 2000 },
            { guid: 'ghost-never-synced', chatGuid: 'c1', dateDeleted: 2500 },
            { guid: 'm2', chatGuid: 'c1', dateDeleted: 3000 },
          ]
        : [],
    );

    const applied = await syncDeletedMessages(db, api(fetch), { supported: true });

    expect(applied).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(1); // short page → no loop
    expect(fetch).toHaveBeenCalledWith(1000, undefined);
    const t = tombstones(raw);
    expect(t.get('m1')).toBe(2000);
    expect(t.get('m2')).toBe(3000);
    expect(
      raw
        .prepare('SELECT date_deleted FROM message_deletion_ledger WHERE guid = ?')
        .pluck()
        .get('ghost-never-synced'),
    ).toBe(2500);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(legacyState(3000));
  });

  it('is idempotent: rows re-emitted at the watermark re-apply as no-ops and the watermark stays put', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 'c1', ['m1', 'm2']);
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, legacyState(1000));

    // The server RE-EMITS rows sharing the watermark's exact ms (fractional-ms flooring), so a
    // rerun sees the same rows again — applying them must change nothing.
    const rows: DeletedMessage[] = [
      { guid: 'm1', chatGuid: 'c1', dateDeleted: 2000 },
      { guid: 'm2', chatGuid: 'c1', dateDeleted: 3000 },
    ];
    const fetch = jest.fn<Promise<DeletedMessage[]>, [number]>(async (after) =>
      after === 1000 ? rows : [rows[1]!],
    );

    await syncDeletedMessages(db, api(fetch), { supported: true });
    const first = tombstones(raw);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(legacyState(3000));

    // Second run: a row at the exact advanced watermark may re-emit; it changes nothing.
    await expect(syncDeletedMessages(db, api(fetch), { supported: true })).resolves.toBe(1);
    expect(fetch).toHaveBeenLastCalledWith(3000, undefined);
    expect(tombstones(raw)).toEqual(first);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(legacyState(3000));
  });

  it('a null dateDeleted row is still tombstoned (now() fallback) but NEVER advances the watermark', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 'c1', ['m3']);
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, legacyState(5000));

    const fetch = jest.fn<Promise<DeletedMessage[]>, [number]>(async (after) =>
      after === 5000 ? [{ guid: 'm3', chatGuid: null, dateDeleted: null }] : [],
    );

    const applied = await syncDeletedMessages(db, api(fetch), {
      supported: true,
      now: () => 999999,
    });

    expect(applied).toBe(1);
    expect(tombstones(raw).get('m3')).toBe(999999); // tombstone applied with the clock fallback
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(legacyState(5000));
  });

  it('loops on a FULL page, advancing the watermark per page, and stops on the short page', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 'c1', ['d1', 'd2', 'd3']);
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, legacyState(5));

    const fetch = jest.fn<Promise<DeletedMessage[]>, [number]>(async (after) => {
      if (after === 5) {
        return [
          { guid: 'd1', chatGuid: 'c1', dateDeleted: 10 },
          { guid: 'd2', chatGuid: 'c1', dateDeleted: 20 },
        ]; // FULL page (pageSize 2) → keep going
      }
      if (after === 20) return [{ guid: 'd3', chatGuid: 'c1', dateDeleted: 30 }]; // short → stop
      return [];
    });

    const applied = await syncDeletedMessages(db, api(fetch), { supported: true, pageSize: 2 });

    expect(applied).toBe(3);
    expect(fetch.mock.calls.map(([after]) => after)).toEqual([5, 20]);
    const t = tombstones(raw);
    expect([t.get('d1'), t.get('d2'), t.get('d3')]).toEqual([10, 20, 30]);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(legacyState(30));
  });

  it('rejects an over-returned page before any tombstone, ledger, or watermark write', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 'c1', ['b1', 'b2', 'b3', 'b4', 'b5']);
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, legacyState(0));
    const fetch = jest.fn<Promise<DeletedMessage[]>, [number]>(async () => [
      { guid: 'b1', chatGuid: 'c1', dateDeleted: 10 },
      { guid: 'b2', chatGuid: 'c1', dateDeleted: 20 },
      { guid: 'b3', chatGuid: 'c1', dateDeleted: 30 },
    ]);

    await expectProtocolError(
      syncDeletedMessages(db, api(fetch), {
        supported: true,
        pageSize: 2.9,
        maxPages: 2.9,
      }),
      'page-over-cap',
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(tombstones(raw)).toEqual(
      new Map([
        ['b1', null],
        ['b2', null],
        ['b3', null],
        ['b4', null],
        ['b5', null],
      ]),
    );
    expect(
      raw
        .prepare("SELECT COUNT(*) FROM message_deletion_ledger WHERE guid LIKE 'b%'")
        .pluck()
        .get(),
    ).toBe(0);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(legacyState(0));
  });

  it.each([
    {
      name: 'a timestamp older than the requested watermark',
      code: 'timestamp-before-watermark' as const,
      rows: [
        { guid: 'v1', chatGuid: 'c1', dateDeleted: 2000 },
        { guid: 'v2', chatGuid: 'c1', dateDeleted: 999 },
      ] satisfies DeletedMessage[],
    },
    {
      name: 'decreasing timestamps',
      code: 'timestamp-out-of-order' as const,
      rows: [
        { guid: 'v3', chatGuid: 'c1', dateDeleted: 3000 },
        { guid: 'v4', chatGuid: 'c1', dateDeleted: 2000 },
      ] satisfies DeletedMessage[],
    },
    {
      name: 'a non-finite timestamp from an alternate SyncApi',
      code: 'invalid-timestamp' as const,
      rows: [
        { guid: 'v5', chatGuid: 'c1', dateDeleted: 2000 },
        { guid: 'v6', chatGuid: 'c1', dateDeleted: Number.POSITIVE_INFINITY },
      ] satisfies DeletedMessage[],
    },
    {
      name: 'an empty guid from an alternate SyncApi',
      code: 'invalid-guid' as const,
      rows: [
        { guid: 'v7', chatGuid: 'c1', dateDeleted: 2000 },
        { guid: '', chatGuid: 'c1', dateDeleted: 3000 },
      ] satisfies DeletedMessage[],
    },
  ])('legacy pages reject $name before any page write', async ({ code, rows }) => {
    const { db, raw } = await createTestDb();
    const seededGuids = rows.map((row) => row.guid).filter((guid) => guid.length > 0);
    await seed(db, 'c1', seededGuids);
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, legacyState(1000));

    await expectProtocolError(
      syncDeletedMessages(
        db,
        api(async () => rows),
        { supported: true },
      ),
      code,
    );

    expect(seededGuids.map((guid) => tombstones(raw).get(guid))).toEqual(
      seededGuids.map(() => null),
    );
    expect(
      raw
        .prepare('SELECT COUNT(*) FROM message_deletion_ledger WHERE guid IN (?, ?)')
        .pluck()
        .get(rows[0]!.guid, rows[1]!.guid),
    ).toBe(0);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(legacyState(1000));
  });

  it('accepts equal timestamps and advances to their shared value', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 'c1', ['tie-1', 'tie-2']);
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, legacyState(1000));

    await expect(
      syncDeletedMessages(
        db,
        api(async () => [
          { guid: 'tie-1', chatGuid: 'c1', dateDeleted: 2000 },
          { guid: 'tie-2', chatGuid: 'c1', dateDeleted: 2000 },
        ]),
        { supported: true },
      ),
    ).resolves.toBe(2);

    expect([tombstones(raw).get('tie-1'), tombstones(raw).get('tie-2')]).toEqual([2000, 2000]);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(legacyState(2000));
  });

  it('ignores a null while checking order and advances a short page from its dated rows', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 'c1', ['mixed-short-null', 'mixed-short-dated']);
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, legacyState(1000));

    await expect(
      syncDeletedMessages(
        db,
        api(async () => [
          { guid: 'mixed-short-null', chatGuid: 'c1', dateDeleted: null },
          { guid: 'mixed-short-dated', chatGuid: 'c1', dateDeleted: 2000 },
        ]),
        { supported: true, now: () => 1500 },
      ),
    ).resolves.toBe(2);

    expect([
      tombstones(raw).get('mixed-short-null'),
      tombstones(raw).get('mixed-short-dated'),
    ]).toEqual([1500, 2000]);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(legacyState(2000));
  });

  it('rolls back every tombstone and the state when a later row fails', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 'c1', ['f1', 'f2', 'f3']);
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, legacyState(1000));
    const rows: DeletedMessage[] = [
      { guid: 'f1', chatGuid: 'c1', dateDeleted: 2000 },
      { guid: 'f2', chatGuid: 'c1', dateDeleted: 3000 },
      { guid: 'f3', chatGuid: 'c1', dateDeleted: 4000 },
    ];
    const fetch = jest.fn<Promise<DeletedMessage[]>, [number]>(async () => rows);
    // Make the second ledger insert fail through an ordinary SQLite constraint. A trigger-based
    // RAISE proved order-dependent when this suite shared a Jest worker with the large repository
    // matrix; this has the same per-row transaction failure without mutable trigger state.
    raw.exec(`
      INSERT INTO message_deletion_ledger (guid, date_deleted)
      VALUES ('failure-sentinel', 3000);
      CREATE UNIQUE INDEX fail_second_deletion
      ON message_deletion_ledger (date_deleted)
    `);
    expect(() =>
      raw
        .prepare(
          `INSERT INTO message_deletion_ledger (guid, date_deleted)
           VALUES ('constraint-preflight', 3000)`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);

    const outcome = await syncDeletedMessages(db, api(fetch), { supported: true }).then(
      (value) => ({
        kind: 'resolved' as const,
        value,
        fetchCalls: fetch.mock.calls,
        tombstones: [...tombstones(raw)],
        ledger: raw
          .prepare('SELECT guid, date_deleted AS dateDeleted FROM message_deletion_ledger')
          .all(),
      }),
      (error: unknown) => ({
        kind: 'rejected' as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    expect(outcome).toEqual({
      kind: 'rejected',
      message: expect.stringMatching(/UNIQUE constraint failed/),
    });
    expect([
      tombstones(raw).get('f1'),
      tombstones(raw).get('f2'),
      tombstones(raw).get('f3'),
    ]).toEqual([null, null, null]);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(legacyState(1000));

    raw.exec(`
      DROP INDEX fail_second_deletion;
      DELETE FROM message_deletion_ledger WHERE guid = 'failure-sentinel'
    `);
    await expect(syncDeletedMessages(db, api(fetch), { supported: true })).resolves.toBe(3);
    expect([
      tombstones(raw).get('f1'),
      tombstones(raw).get('f2'),
      tombstones(raw).get('f3'),
    ]).toEqual([2000, 3000, 4000]);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(legacyState(4000));
  });

  it('breaks (bounded) on a full page that cannot advance the watermark instead of spinning', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 'c1', ['n1', 'n2']);
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, legacyState(7000));

    // A full page with even one null timestamp has no safe continuation cursor. The dated row
    // proves we do not advance merely because another row could move the watermark.
    const fetch = jest.fn<Promise<DeletedMessage[]>, [number]>(async () => [
      { guid: 'n1', chatGuid: null, dateDeleted: null },
      { guid: 'n2', chatGuid: null, dateDeleted: 8000 },
    ]);

    const applied = await syncDeletedMessages(db, api(fetch), {
      supported: true,
      pageSize: 2,
      now: () => 424242,
    });

    expect(applied).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(1); // no watermark advance → no refetch of the same page
    expect(tombstones(raw).get('n1')).toBe(424242);
    expect(tombstones(raw).get('n2')).toBe(8000);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe(legacyState(7000));
  });
});
