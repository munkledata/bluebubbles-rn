import type Database from 'better-sqlite3';
import { Message } from '@core/models';
import type { DeletedMessage } from '@core/api/endpoints/messages';
import { kvGet, kvSet, upsertChats, upsertHandles, upsertMessages } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { DELETIONS_SYNCED_AT_KEY, syncDeletedMessages } from '@/services/sync/engine';
import type { SyncApi } from '@/services/sync/types';
import { createTestDb } from '../support/testDb';

/**
 * R1 deletion catch-up sync (engine-level): a `message-deleted` event that fires while the app is
 * dead or app-locked is LOST (the locked FCM path never touches the DB), so syncDeletedMessages
 * pages GET /message/deleted after the persisted watermark and re-applies the tombstones.
 */

function api(fetchDeletedAfter: SyncApi['fetchDeletedAfter']): SyncApi {
  return {
    serverVersion: async () => '1.9.0',
    fetchChats: async () => [],
    fetchChatMessages: async () => [],
    fetchMessagesAfter: async () => [],
    fetchDeletedAfter,
  };
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
  const rows = raw.prepare('SELECT guid, date_deleted AS d FROM messages').all() as Array<{
    guid: string;
    d: number | null;
  }>;
  return new Map(rows.map((r) => [r.guid, r.d]));
}

describe('syncDeletedMessages — R1 deletion catch-up', () => {
  it('does NOTHING when the capability is unsupported: no fetch, no watermark seed', async () => {
    const { db } = await createTestDb();
    const fetch = jest.fn<Promise<DeletedMessage[]>, [number]>(async () => [
      { guid: 'never-applied', chatGuid: null, dateDeleted: 123 },
    ]);

    const applied = await syncDeletedMessages(db, api(fetch), { supported: false });

    expect(applied).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    // No seed either — the first SUPPORTED run owns the seeding.
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBeNull();
  });

  it('FIRST run seeds the watermark to now() and does NOT replay server deletion history', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 'c1', ['m1']);
    // The server would happily return its whole pre-existing deletion history for after=0 —
    // the seed must prevent that fetch entirely (mirrors the server's own seeding argument).
    const fetch = jest.fn<Promise<DeletedMessage[]>, [number]>(async () => [
      { guid: 'm1', chatGuid: 'c1', dateDeleted: 111 },
    ]);

    const applied = await syncDeletedMessages(db, api(fetch), {
      supported: true,
      now: () => 1700000123456,
    });

    expect(applied).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe('1700000123456');
    // History NOT replayed: the pre-existing local row is untouched.
    expect(tombstones(raw).get('m1')).toBeNull();
  });

  it('applies deletions after the watermark (unknown guid = safe no-op) and advances it to the max dateDeleted', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 'c1', ['m1', 'm2']);
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, '1000');

    const fetch = jest.fn<Promise<DeletedMessage[]>, [number]>(async (after) =>
      after === 1000
        ? [
            { guid: 'm1', chatGuid: 'c1', dateDeleted: 2000 },
            { guid: 'ghost-never-synced', chatGuid: null, dateDeleted: 2500 },
            { guid: 'm2', chatGuid: 'c1', dateDeleted: 3000 },
          ]
        : [],
    );

    const applied = await syncDeletedMessages(db, api(fetch), { supported: true });

    expect(applied).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(1); // short page → no loop
    expect(fetch).toHaveBeenCalledWith(1000);
    const t = tombstones(raw);
    expect(t.get('m1')).toBe(2000);
    expect(t.get('m2')).toBe(3000);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe('3000');
  });

  it('is idempotent: rows re-emitted at the watermark re-apply as no-ops and the watermark stays put', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 'c1', ['m1', 'm2']);
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, '1000');

    // The server RE-EMITS rows sharing the watermark's exact ms (fractional-ms flooring), so a
    // rerun sees the same rows again — applying them must change nothing.
    const rows: DeletedMessage[] = [
      { guid: 'm1', chatGuid: 'c1', dateDeleted: 2000 },
      { guid: 'm2', chatGuid: 'c1', dateDeleted: 3000 },
    ];
    const fetch = jest.fn<Promise<DeletedMessage[]>, [number]>(async () => rows);

    await syncDeletedMessages(db, api(fetch), { supported: true });
    const first = tombstones(raw);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe('3000');

    // Second run: called with the advanced watermark; same rows come back; nothing changes.
    await expect(syncDeletedMessages(db, api(fetch), { supported: true })).resolves.toBe(2);
    expect(fetch).toHaveBeenLastCalledWith(3000);
    expect(tombstones(raw)).toEqual(first);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe('3000');
  });

  it('a null dateDeleted row is still tombstoned (now() fallback) but NEVER advances the watermark', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 'c1', ['m3']);
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, '5000');

    const fetch = jest.fn<Promise<DeletedMessage[]>, [number]>(async (after) =>
      after === 5000 ? [{ guid: 'm3', chatGuid: null, dateDeleted: null }] : [],
    );

    const applied = await syncDeletedMessages(db, api(fetch), {
      supported: true,
      now: () => 999999,
    });

    expect(applied).toBe(1);
    expect(tombstones(raw).get('m3')).toBe(999999); // tombstone applied with the clock fallback
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe('5000'); // watermark NOT advanced on null
  });

  it('loops on a FULL page, advancing the watermark per page, and stops on the short page', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 'c1', ['d1', 'd2', 'd3']);
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, '5');

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
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe('30');
  });

  it('breaks (bounded) on a full page that cannot advance the watermark instead of spinning', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 'c1', ['n1', 'n2']);
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, '7000');

    // A pathological full page of null-dateDeleted rows: identical on every refetch.
    const fetch = jest.fn<Promise<DeletedMessage[]>, [number]>(async () => [
      { guid: 'n1', chatGuid: null, dateDeleted: null },
      { guid: 'n2', chatGuid: null, dateDeleted: null },
    ]);

    const applied = await syncDeletedMessages(db, api(fetch), {
      supported: true,
      pageSize: 2,
      now: () => 424242,
    });

    expect(applied).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(1); // no watermark advance → no refetch of the same page
    expect(tombstones(raw).get('n1')).toBe(424242);
    expect(await kvGet(db, DELETIONS_SYNCED_AT_KEY)).toBe('7000');
  });
});
