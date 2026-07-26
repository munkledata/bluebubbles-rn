import { Chat, Message } from '@core/models';
import { GuidDeduper, type SyncCursor } from '@core/sync';
import {
  listChats,
  listChatsForInbox,
  listMessages,
  getSyncMarker,
  setSyncMarker,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { fullSync, incrementalSync, INCREMENTAL_TX_CHUNK } from '@/services/sync/engine';
import type { AppDatabase } from '@db/types';
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

/** An inbound message — the only kind the read marker may point at. */
function received(guid: string, dateCreated: number) {
  return Message.parse({
    guid,
    text: guid,
    dateCreated,
    isFromMe: false,
    handle: { address: 'a@x.com' },
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

  /**
   * REGRESSION — the Mac's read state used to be fetched and thrown away on every fresh install.
   *
   * The read-watermark reconcile lives inside `upsertChats`, which necessarily runs BEFORE the
   * messages it must resolve the watermark against. In PRODUCTION ORDER (chats first, messages
   * second) the guard `MAX(m.date_created) > current` therefore evaluated NULL > 0 and every
   * UPDATE matched zero rows — so the app opened with a full unread badge on every conversation
   * the user had already read on their Mac. `test/db/readReconcile.test.ts` cannot see this: it
   * seeds the messages FIRST, which is the exact reverse of what a first sync does.
   */
  it('applies the Mac read watermark even though the chats are written before their messages', async () => {
    const { db, raw } = await createTestDb();
    const api: SyncApi = {
      serverVersion: async () => '1.9.0',
      fetchChats: async (offset) =>
        offset === 0
          ? [
              Chat.parse({
                guid: 'cRead',
                displayName: 'Read on the Mac',
                participants: [{ address: 'a@x.com' }],
                // Read up to (and including) r2 on the Mac.
                lastReadMessageTimestamp: 2500,
              }),
            ]
          : [],
      fetchChatMessages: async (guid, offset) =>
        guid === 'cRead' && offset === 0
          ? [
              received('r1', 1000),
              received('r2', 2000),
              received('r3', 3000), // arrived after the Mac's watermark → still unread
            ]
          : [],
      fetchMessagesAfter: async () => [],
      fetchDeletedAfter: async () => [],
    };

    await fullSync(db, api);

    const marker = raw
      .prepare('SELECT last_read_message_guid g FROM chats WHERE guid = ?')
      .get('cRead') as { g: string | null };
    expect(marker.g).toBe('r2'); // newest received at/before the watermark
    const inbox = await listChatsForInbox(db);
    expect(inbox.find((c) => c.guid === 'cRead')?.unreadCount).toBe(1);
  });
});

/**
 * A Disconnect landing mid-sync.
 *
 * Everything else that protects the wipe is fetch-shaped: `forget()` clears the credentials first,
 * so every remaining request fails and no fetch-then-write phase can persist anything. The closing
 * phases of `fullSync` are the exception — they write from the phase-1 snapshot held in memory and
 * from the local messages table, and make no request at all. `forget()` waits for the run, but only
 * for a bounded 20 s, which a large account's phase-2 backfill outlives; the wipe then lands while
 * this is still going. `upsertChats` is an INSERT … ON CONFLICT, so re-applying the read watermarks
 * from that stale snapshot RE-CREATES the disconnected account's chats — the cross-account leak the
 * wipe exists to close, reintroduced from inside the sync.
 */
describe('fullSync — a session that ends mid-run', () => {
  /** Everything `clearLocalCache` empties that `fullSync` could put back. */
  const wipe = (raw: { exec: (s: string) => unknown }): void => {
    raw.exec(
      'DELETE FROM messages; DELETE FROM chat_handles; DELETE FROM chats; DELETE FROM handles;',
    );
    raw.exec('UPDATE sync_markers SET last_synced_row_id = NULL, last_synced_timestamp = NULL');
  };

  /** Phase 1 succeeds; the Disconnect + wipe land during phase 2, and every later fetch fails. */
  function disconnectingApi(onWipe: () => void): SyncApi {
    return {
      serverVersion: async () => '1.9.0',
      fetchChats: async (offset) =>
        offset === 0
          ? [
              Chat.parse({
                guid: 'cGone',
                displayName: 'Previous account',
                participants: [{ address: 'a@x.com' }],
                lastReadMessageTimestamp: 2500,
              }),
            ]
          : [],
      fetchChatMessages: async () => {
        onWipe();
        // With the origin cleared, a request builds a relative URL and fails immediately.
        throw new Error('no_connection');
      },
      fetchMessagesAfter: async () => [],
      fetchDeletedAfter: async () => [],
    };
  }

  it('writes nothing after the wipe when the session it started under is gone', async () => {
    const { db, raw } = await createTestDb();
    let disconnected = false;
    const api = disconnectingApi(() => {
      disconnected = true;
      wipe(raw);
    });

    await fullSync(db, api, { shouldAbort: () => disconnected });

    expect(await listChats(db)).toEqual([]);
    expect(await getSyncMarker(db)).toEqual({
      lastSyncedRowId: null,
      lastSyncedTimestamp: null,
    });
  });

  /**
   * The guard is the whole fix, so prove it is load-bearing rather than decorative: the identical
   * run without it puts the disconnected account's chat straight back into the emptied table.
   */
  it('without the guard, the wiped chat is re-created from the in-memory snapshot', async () => {
    const { db, raw } = await createTestDb();

    await fullSync(
      db,
      disconnectingApi(() => wipe(raw)),
    );

    const back = (await listChats(db)) as Array<{ guid: string }>;
    expect(back.map((c) => c.guid)).toEqual(['cGone']);
  });
});

describe('incrementalSync', () => {
  /**
   * The one gap in "the cursor never outruns the rows", stated so it stays deliberate.
   *
   * `upsertMessages` drops a message it cannot attach to a chat, but `nextMarker` is computed from
   * the whole page, so the strictly-forward cursor moves past it and it is never fetched again. The
   * server does return such rows (a message with no `chat_message_join` arrives with `chats: []`),
   * and holding the marker back for one would refetch the identical page forever — so advancing is
   * correct and the slice logs the count instead. This pins that behaviour rather than the log.
   */
  it('advances past a message with no resolvable chat rather than wedging on it', async () => {
    const { db } = await createTestDb();
    await setSyncMarker(db, { lastSyncedRowId: 0, lastSyncedTimestamp: 0 });
    const orphan = Message.parse({
      guid: 'orphan',
      text: 'no thread to attach to',
      originalROWID: 42,
      dateCreated: 4200,
      chats: [],
    });
    const api: SyncApi = {
      serverVersion: async () => '1.9.0',
      fetchChats: async () => [],
      fetchChatMessages: async () => [],
      fetchDeletedAfter: async () => [],
      fetchMessagesAfter: async (cursor) =>
        cursor.mode === 'rowid' && cursor.after === 0 ? [orphan] : [],
    };

    await expect(incrementalSync(db, api, { serverVersion: '1.9.0' })).resolves.toBeDefined();

    expect(await getSyncMarker(db)).toMatchObject({ lastSyncedRowId: 42 });
    expect(await listChats(db)).toEqual([]); // nothing invented to hold it
  });

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

/**
 * A sync page and the marker that says "we already have it" must commit together.
 *
 * There is ONE shared connection, so plain autocommit writes JOIN whatever transaction another
 * writer happens to have open — and a rollback THERE erases them. The marker would still commit
 * (it is computed from what the SERVER returned, not from what persisted) and `buildSyncCursor` is
 * a strict forward cursor, so the erased messages are never fetched again: they are simply gone,
 * with no error anywhere.
 */
describe('incrementalSync — page write atomicity', () => {
  it('a neighbouring rollback cannot erase a page the sync already counted', async () => {
    const { db } = await createTestDb();
    await setSyncMarker(db, { lastSyncedRowId: 0, lastSyncedTimestamp: 0 });

    // Hold a doomed transaction open, then run the sync while it is mid-flight.
    let markBegun = (): void => {};
    const begun = new Promise<void>((r) => {
      markBegun = r;
    });
    let releaseGate = (): void => {};
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const doomed = withDbTransaction(db, async () => {
      markBegun();
      await gate;
      throw new Error('neighbouring transaction failed');
    });
    await begun; // BEGIN IMMEDIATE has run — the connection is inside a transaction

    const api: SyncApi = {
      serverVersion: async () => '1.9.0',
      fetchChats: async () => [],
      fetchChatMessages: async () => [],
      fetchDeletedAfter: async () => [],
      fetchMessagesAfter: async (cursor) =>
        cursor.mode === 'rowid' && cursor.after === 0 ? [msg('atomic-1', 7, 'keep me', 'cAt')] : [],
    };
    const syncing = incrementalSync(db, api, {
      serverVersion: '1.9.0',
      batchSize: 5,
      deduper: new GuidDeduper(),
    });
    // Give the sync every chance to run its writes inside the open transaction (microtasks drain
    // before this macrotask) — which is exactly what used to happen.
    await new Promise((r) => setTimeout(r, 0));

    releaseGate();
    await expect(doomed).rejects.toThrow('neighbouring transaction failed');
    const result = await syncing;

    expect(result.messages).toBe(1);
    const chats = (await listChats(db)) as Array<{ id: number; guid: string }>;
    const cAt = chats.find((c) => c.guid === 'cAt');
    expect(cAt).toBeDefined(); // the page's chat survived the neighbour's rollback
    expect((await listMessages(db, cAt!.id)) as unknown[]).toHaveLength(1);
    // …and the cursor that claims we have it is durable for the same reason.
    expect(await getSyncMarker(db)).toMatchObject({ lastSyncedRowId: 7 });
  });
});

/**
 * …but that transaction must stay SHORT.
 *
 * `withDbTransaction` is a global mutex over ONE shared connection: while it is open every other
 * writer either waits on the lock or, if it is a plain autocommit write (an optimistic send, a
 * read marker), silently JOINS the transaction and is destroyed with it on a rollback. A whole
 * 250-message page in one transaction is hundreds of statements of that, which is exactly the
 * bystander trap the transaction helper exists to escape — so a page is written in slices, and
 * the marker rides the LAST one.
 */
describe('incrementalSync — page transaction scope', () => {
  /** Spy on the raw BEGIN/COMMIT/ROLLBACK statements `withDbTransaction` issues. */
  function traceTransactions(db: AppDatabase, opts: { throwOnBegin?: number } = {}): () => number {
    const run = db.run.bind(db) as (q: unknown) => unknown;
    let begins = 0;
    (db as unknown as { run: (q: unknown) => unknown }).run = (q: unknown) => {
      if (JSON.stringify(q).includes('BEGIN')) {
        begins += 1;
        if (begins === opts.throwOnBegin) throw new Error('write lock unavailable');
      }
      return run(q);
    };
    return () => begins;
  }

  /** Rows actually committed — `listMessages` pages, so it can't count a >100-row slice run. */
  function countMessages(raw: { prepare: (s: string) => { get: () => unknown } }): number {
    return (raw.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
  }

  /** A page of `n` messages, all in one chat, delivered as a single short page. */
  function pageOf(n: number): SyncApi {
    const page = Array.from({ length: n }, (_, i) => msg(`scope-${i}`, i + 1, 'x', 'cScope'));
    return {
      serverVersion: async () => '1.9.0',
      fetchChats: async () => [],
      fetchChatMessages: async () => [],
      fetchDeletedAfter: async () => [],
      fetchMessagesAfter: async (cursor) =>
        cursor.mode === 'rowid' && cursor.after === 0 ? page : [],
    };
  }

  it('writes a page in slices rather than one page-wide transaction', async () => {
    const { db, raw } = await createTestDb();
    await setSyncMarker(db, { lastSyncedRowId: 0, lastSyncedTimestamp: 0 });
    const total = INCREMENTAL_TX_CHUNK * 2 + 1; // three slices, the last a partial one
    const begins = traceTransactions(db);

    const result = await incrementalSync(db, pageOf(total), {
      serverVersion: '1.9.0',
      batchSize: total + 1, // a short page → exactly one round of the loop
      deduper: new GuidDeduper(),
    });

    expect(result.messages).toBe(total);
    expect(begins()).toBe(3);
    expect(countMessages(raw)).toBe(total);
    expect(await getSyncMarker(db)).toMatchObject({ lastSyncedRowId: total });
  });

  it('leaves the marker behind when a later slice fails, so the page is simply re-fetched', async () => {
    const { db, raw } = await createTestDb();
    await setSyncMarker(db, { lastSyncedRowId: 0, lastSyncedTimestamp: 0 });
    const total = INCREMENTAL_TX_CHUNK * 2;
    traceTransactions(db, { throwOnBegin: 2 }); // the second slice never gets the lock

    await expect(
      incrementalSync(db, pageOf(total), {
        serverVersion: '1.9.0',
        batchSize: total + 1,
        deduper: new GuidDeduper(),
      }),
    ).rejects.toThrow('write lock unavailable');

    // The first slice is durable — rows without a marker cost one redundant re-fetch, nothing more.
    expect(countMessages(raw)).toBe(INCREMENTAL_TX_CHUNK);
    // The marker must NOT have moved: `buildSyncCursor` never looks back, so a marker ahead of the
    // rows would lose the un-written half of this page for good.
    expect(await getSyncMarker(db)).toMatchObject({ lastSyncedRowId: 0 });
  });
});
