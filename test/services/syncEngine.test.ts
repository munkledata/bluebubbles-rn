import { Chat, Message } from '@core/models';
import { GuidDeduper, type SyncCursor } from '@core/sync';
import { listChats, listMessages, getSyncMarker, setSyncMarker } from '@db/repositories';
import { fullSync, incrementalSync } from '@/services/sync/engine';
import type { SyncApi } from '@/services/sync/types';
import { createTestDb } from '../support/testDb';

function msg(guid: string, rowId: number, text: string, chatGuid: string) {
  return Message.parse({
    guid,
    text,
    originalROWID: rowId,
    dateCreated: rowId * 100,
    chats: [{ guid: chatGuid, participants: [{ address: 'alice@me.com' }] }],
  });
}

describe('fullSync', () => {
  it('pages chats + per-chat messages into the DB and sets the marker', async () => {
    const { db } = await createTestDb();
    const api: SyncApi = {
      serverVersion: async () => '1.9.0',
      fetchChats: async (offset) =>
        offset === 0
          ? [
              Chat.parse({
                guid: 'c1',
                displayName: 'One',
                participants: [{ address: 'a@x.com' }],
              }),
              Chat.parse({
                guid: 'c2',
                displayName: 'Two',
                participants: [{ address: 'b@x.com' }],
              }),
            ]
          : [],
      fetchChatMessages: async (guid, offset) => {
        if (offset !== 0) return [];
        if (guid === 'c1') return [msg('m1', 11, 'hi', 'c1'), msg('m2', 12, 'yo', 'c1')];
        if (guid === 'c2') return [msg('m3', 20, 'sup', 'c2')];
        return [];
      },
      fetchMessagesAfter: async () => [],
      fetchDeletedAfter: async () => [],
    };

    const result = await fullSync(db, api);
    expect(result).toEqual({ chats: 2, messages: 3 });

    const chats = (await listChats(db)) as Array<{ id: number; guid: string }>;
    expect(chats.map((c) => c.guid).sort()).toEqual(['c1', 'c2']);
    const c1 = chats.find((c) => c.guid === 'c1')!;
    expect(await listMessages(db, c1.id)).toHaveLength(2);

    // Marker advanced to the highest rowid/date stored.
    expect(await getSyncMarker(db)).toEqual({ lastSyncedRowId: 20, lastSyncedTimestamp: 2000 });
  });
});

describe('incrementalSync', () => {
  it('uses the rowid cursor, paginates, dedups, and advances the marker', async () => {
    const { db } = await createTestDb();
    await setSyncMarker(db, { lastSyncedRowId: 10, lastSyncedTimestamp: 1000 });

    const cursors: SyncCursor[] = [];
    const api: SyncApi = {
      serverVersion: async () => '1.9.0',
      fetchChats: async () => [],
      fetchChatMessages: async () => [],
      fetchDeletedAfter: async () => [],
      fetchMessagesAfter: async (cursor) => {
        cursors.push(cursor);
        if (cursor.mode === 'rowid' && cursor.after === 10) {
          // full batch (== batchSize) so the loop continues; m2 repeats next page
          return [msg('m1', 11, 'one', 'cX'), msg('m2', 12, 'two', 'cX')];
        }
        if (cursor.mode === 'rowid' && cursor.after === 12) {
          return [msg('m2', 12, 'two', 'cX')]; // duplicate guid → deduped
        }
        return [];
      },
    };

    const result = await incrementalSync(db, api, {
      serverVersion: '1.9.0',
      batchSize: 2,
      deduper: new GuidDeduper(),
    });

    expect(result.messages).toBe(2); // m1, m2 (duplicate not double-counted)
    expect(cursors[0]).toEqual({ mode: 'rowid', after: 10 });
    expect(cursors[1]).toEqual({ mode: 'rowid', after: 12 }); // advanced past the batch
    expect(await getSyncMarker(db)).toMatchObject({ lastSyncedRowId: 12 });

    // The embedded chat 'cX' was created and the messages attached to it.
    const chats = (await listChats(db)) as Array<{ id: number; guid: string }>;
    const cx = chats.find((c) => c.guid === 'cX')!;
    expect(cx).toBeDefined();
    expect(await listMessages(db, cx.id)).toHaveLength(2);
  });

  it('reports progress per page (not just at the end) so the inbox hydrates mid-sync', async () => {
    const { db } = await createTestDb();
    await setSyncMarker(db, { lastSyncedRowId: 0, lastSyncedTimestamp: 0 });

    // Two full pages then an empty one → the loop persists each page before the next.
    const api: SyncApi = {
      serverVersion: async () => '1.9.0',
      fetchChats: async () => [],
      fetchChatMessages: async () => [],
      fetchDeletedAfter: async () => [],
      fetchMessagesAfter: async (cursor) => {
        if (cursor.mode === 'rowid' && cursor.after === 0) {
          return [msg('m1', 1, 'a', 'cA'), msg('m2', 2, 'b', 'cA')];
        }
        if (cursor.mode === 'rowid' && cursor.after === 2) {
          return [msg('m3', 3, 'c', 'cB'), msg('m4', 4, 'd', 'cB')];
        }
        return [];
      },
    };

    const ticks: { chats: number; messages: number }[] = [];
    const result = await incrementalSync(db, api, {
      serverVersion: '1.9.0',
      batchSize: 2,
      deduper: new GuidDeduper(),
      onProgress: (p) => ticks.push({ ...p }),
    });

    // One tick per persisted page, with monotonically growing running counts.
    expect(ticks).toEqual([
      { chats: 1, messages: 2 },
      { chats: 2, messages: 4 },
    ]);
    expect(result).toEqual({ chats: 2, messages: 4 });
  });

  it('falls back to a timestamp cursor on older servers', async () => {
    const { db } = await createTestDb();
    await setSyncMarker(db, { lastSyncedRowId: null, lastSyncedTimestamp: 5000 });
    let seen: SyncCursor | null = null;
    const api: SyncApi = {
      serverVersion: async () => '1.5.0',
      fetchChats: async () => [],
      fetchChatMessages: async () => [],
      fetchDeletedAfter: async () => [],
      fetchMessagesAfter: async (cursor) => {
        seen = cursor;
        return [];
      },
    };
    await incrementalSync(db, api, { serverVersion: '1.5.0' });
    expect(seen!.mode).toBe('timestamp');
  });

  /**
   * REGRESSION: incrementalSync used to loop forever on a stalled cursor.
   *
   * The loop breaks only on an empty or SHORT page. `advanceMarker` takes a STRICT max, so a FULL
   * page whose rows are none of them newer than the marker leaves it unchanged — and
   * `buildSyncCursor` then rebuilds a byte-identical cursor and refetches the identical page.
   * `GuidDeduper` makes `fresh` empty on the repeat, so there are no DB writes and no error: it
   * spins on the network silently, forever.
   *
   * Reachable in timestamp mode (used whenever lastSyncedRowId is null, i.e. the first page after
   * install and permanently if the server omits originalROWID) when >= batchSize messages share a
   * timestamp inside the 5s overlap window, or a whole page has null dateCreated.
   *
   * Without the termination guard this test does not fail — it HANGS until jest times out.
   */
  it('stops instead of refetching forever when a full page does not advance the marker', async () => {
    const { db } = await createTestDb();
    await setSyncMarker(db, { lastSyncedRowId: null, lastSyncedTimestamp: 5_000 });

    let calls = 0;
    // Every row sits AT the marker, so the strict-max advance is a no-op and the next cursor is
    // identical. A full page (== batchSize) means the short-page break never fires either.
    const stalled = [
      Message.parse({
        guid: 's1',
        text: 'a',
        dateCreated: 5_000,
        chats: [{ guid: 'cS', participants: [{ address: 'alice@me.com' }] }],
      }),
      Message.parse({
        guid: 's2',
        text: 'b',
        dateCreated: 5_000,
        chats: [{ guid: 'cS', participants: [{ address: 'alice@me.com' }] }],
      }),
    ];

    const api: SyncApi = {
      serverVersion: async () => '1.5.0',
      fetchChats: async () => [],
      fetchChatMessages: async () => [],
      fetchDeletedAfter: async () => [],
      fetchMessagesAfter: async () => {
        calls += 1;
        if (calls > 20) throw new Error('incrementalSync did not terminate — it refetched forever');
        return stalled;
      },
    };

    const result = await incrementalSync(db, api, {
      serverVersion: '1.5.0',
      batchSize: 2, // page length === batchSize → the "short page" break cannot fire
      deduper: new GuidDeduper(),
    });

    // It must stop after detecting the stall, not spin.
    expect(calls).toBe(1);
    expect(result.messages).toBe(2); // the page's rows were still ingested before stopping
    expect(await getSyncMarker(db)).toMatchObject({ lastSyncedTimestamp: 5_000 });
  });
});
