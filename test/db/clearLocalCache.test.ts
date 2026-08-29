/**
 * `clearLocalCache` is what makes Disconnect actually disconnect: without it, reconnecting to a
 * DIFFERENT server leaves the previous account's threads in the inbox and the surviving sync
 * marker forces the incremental branch off the OLD server's ROWID cursor.
 *
 * These tests pin both halves of the contract — everything server-derived or server-ADDRESSED goes
 * (including the error-report upload backlog and the per-chat composer drafts, whose guid keys
 * repeat across servers), and the user's GLOBAL state stays (settings, themes, device contacts).
 */
import { Attachment, Chat, Message } from '@core/models';
import {
  DELETIONS_WATERMARK_KV_KEY,
  DRAFT_KV_PREFIX,
  NOTIFICATION_ROUTE_KV_PREFIX,
  clearLocalCache,
  createCustomFolder,
  createReminder,
  enqueueIncomingEvent,
  getSyncMarker,
  insertErrorReport,
  insertOutgoingText,
  insertScheduled,
  kvGet,
  kvSet,
  localCacheDirty,
  recordAttachmentCacheEntry,
  replaceCustomFolderMembership,
  searchMessages,
  setSyncMarker,
  setUrlPreview,
  THEME_PREF_KEY,
  upsertChats,
  upsertContacts,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { withDbTransaction } from '@db/transaction';
import { DELETIONS_SYNCED_AT_KEY } from '@/services/sync/engine';
import { createTestDb } from '../support/testDb';

const SETTING_KEY = 'sync.messagesPerChat';
const INCOMING_DIGEST = 'a'.repeat(64);

/** A device with real history: chats, messages, attachments, queued work and user settings. */
async function seed(db: AppDatabase): Promise<void> {
  const handles = await upsertHandles(db, [{ address: 'a@x.com', displayName: 'Alice' }]);
  const map = await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', displayName: 'Alice', participants: [{ address: 'a@x.com' }] })],
    handles,
  );
  const chatId = map.get('c1')!;
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: 'm1',
        text: 'confidential picnic plans',
        dateCreated: 1000,
        handle: { address: 'a@x.com' },
        hasAttachments: true,
        attachments: [Attachment.parse({ guid: 'att-1', mimeType: 'image/jpeg' })],
      }),
    ],
    () => chatId,
    handles,
  );

  await insertOutgoingText(db, {
    tempGuid: 'temp-1',
    chatId,
    chatGuid: 'c1',
    text: 'unsent draft',
    now: 2000,
  });
  await insertScheduled(db, { chatGuid: 'c1', text: 'later', scheduledFor: 9_000_000 });
  await createReminder(db, {
    messageGuid: 'm1',
    chatGuid: 'c1',
    messagePreview: 'confidential picnic plans',
    senderName: 'Alice',
    scheduledFor: 9_000_000,
    notificationId: 'notif-1',
  });
  await setUrlPreview(db, 'https://example.com', { title: 'Example' }, 3000);
  // Captured under THIS server; nothing binds the row to an origin, so an undrained backlog would
  // otherwise be uploaded to whichever server connects next.
  await insertErrorReport(
    db,
    {
      level: 'error',
      message: '[send] boom',
      stack: 'at send (send.ts:1)',
      tag: 'send',
      meta: null,
      createdAt: 5000,
    },
    5000,
  );
  await enqueueIncomingEvent(
    db,
    {
      eventKey: 'new-message:m1',
      payloadDigest: INCOMING_DIGEST,
      orderingKey: 'message:m1',
      eventName: 'new-message',
      source: 'fcm',
      payload: '{"guid":"m1","text":"confidential picnic plans"}',
      receivedAt: 5000,
      expiresAt: 5000 + 60_000,
    },
    () => true,
    () => 5000,
  );
  await withDbTransaction(db, (context) =>
    recordAttachmentCacheEntry(context, {
      path: 'file:///documents/attachments/att-1/image.jpg',
      bytes: 1234,
      lastUsedAt: 5000,
    }),
  );
  const folder = await createCustomFolder(db, 'Private plans');
  await replaceCustomFolderMembership(db, folder.id, ['c1', 'temporarily-missing-chat']);

  await setSyncMarker(db, { lastSyncedRowId: 4321, lastSyncedTimestamp: 1000 });
  await kvSet(db, DELETIONS_WATERMARK_KV_KEY, '1234');
  // A per-chat composer draft — kv, but chat-scoped and keyed by a guid that repeats across
  // servers, so it must go with the chat row.
  await kvSet(db, `${DRAFT_KV_PREFIX}c1`, 'tell him I am leaving');
  await kvSet(
    db,
    `${NOTIFICATION_ROUTE_KV_PREFIX}00000000-0000-4000-8000-000000000000`,
    'old-account-call-uuid',
  );

  // User-owned state that must SURVIVE a disconnect.
  await kvSet(db, THEME_PREF_KEY, 'gator');
  await kvSet(db, SETTING_KEY, '25');
  await upsertContacts(db, [
    {
      sourceId: 'ct-1',
      displayName: 'Alice',
      givenName: 'Alice',
      familyName: null,
      phones: [],
      emails: ['a@x.com'],
      avatar: null,
    },
  ]);
}

type RawDb = Awaited<ReturnType<typeof createTestDb>>['raw'];
const count = (raw: RawDb, table: string): number =>
  (raw.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;

const nextEventLoopTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

interface DriverGate {
  didStart: boolean;
  held: Promise<void>;
  finished: Promise<void>;
  release(): void;
  markFinished(): void;
}

function driverGate(): DriverGate {
  let release!: () => void;
  let markFinished!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve;
  });
  return { didStart: false, held, finished, release, markFinished };
}

async function waitForCondition(condition: () => boolean, label: string): Promise<void> {
  for (let turn = 0; turn < 20 && !condition(); turn += 1) {
    await nextEventLoopTurn();
  }
  if (!condition()) throw new Error(`${label} did not start within 20 event-loop turns`);
}

/** Native SQLite errors can belong to a prior Jest VM, so match their text without `instanceof`. */
async function expectForeignKeyRejection(promise: Promise<unknown>): Promise<void> {
  const outcome = await promise.then(
    () => ({ kind: 'resolved' as const }),
    (error: unknown) => ({ kind: 'rejected' as const, message: String(error) }),
  );
  expect(outcome).toEqual({
    kind: 'rejected',
    message: expect.stringMatching(/FOREIGN KEY constraint failed/),
  });
}

describe('clearLocalCache', () => {
  it('empties every server-derived table', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    raw
      .prepare(
        `INSERT INTO message_deletion_ledger (guid, date_deleted)
         VALUES ('deleted-on-old-account', 5000)`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO message_guid_aliases (alias_guid, canonical_guid)
         VALUES ('temp-old-account', 'real-old-account')`,
      )
      .run();
    expect(count(raw, 'messages')).toBeGreaterThan(0);

    await clearLocalCache(db);

    for (const table of [
      'incoming_event_queue',
      'message_deletion_ledger',
      'message_guid_aliases',
      'attachment_cache_entries',
      'attachments',
      'messages',
      'chat_handles',
      'custom_folder_members',
      'custom_folders',
      'chats',
      'handles',
      'outgoing_queue',
      'scheduled_messages',
      'reminders',
      'url_previews',
      'error_reports',
    ]) {
      expect({ table, rows: count(raw, table) }).toEqual({ table, rows: 0 });
    }
  });

  it('leaves no searchable text behind (the FTS delete trigger fires)', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    const indexed = (): unknown[] =>
      raw.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'picnic'`).all();
    expect(await searchMessages(db, 'picnic')).toHaveLength(1);
    // Proves the assertion below is not vacuous: the term IS in the index to begin with.
    expect(indexed()).toHaveLength(1);

    await clearLocalCache(db);

    // Assert against the INDEX itself, not through `searchMessages` — that joins `messages`, which
    // the wipe empties either way, so it returns [] whether the `messages_ad` trigger fired or was
    // bypassed. Only this can catch a stale index still holding the old account's message text.
    expect(indexed()).toHaveLength(0);
    // …and the user-visible check on top.
    expect(await searchMessages(db, 'picnic')).toHaveLength(0);
  });

  it('resets the sync marker in place so the next sync runs FULL', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);

    await clearLocalCache(db);

    expect(await getSyncMarker(db)).toEqual({ lastSyncedRowId: null, lastSyncedTimestamp: null });
    // The row itself must survive — setSyncMarker is an UPDATE, so a deleted row would silently
    // swallow every future marker write.
    expect(count(raw, 'sync_markers')).toBe(1);
    await setSyncMarker(db, { lastSyncedRowId: 7, lastSyncedTimestamp: 8 });
    expect(await getSyncMarker(db)).toEqual({ lastSyncedRowId: 7, lastSyncedTimestamp: 8 });
  });

  it('drops the deletion watermark + per-chat drafts but keeps settings, themes and device contacts', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);

    await clearLocalCache(db);

    expect(await kvGet(db, DELETIONS_WATERMARK_KV_KEY)).toBeNull();
    // Chat-scoped and guid-keyed: surviving would pre-fill the NEXT account's composer with the
    // previous user's unsent text (1:1 guids are `service;-;address`, identical across servers).
    expect(await kvGet(db, `${DRAFT_KV_PREFIX}c1`)).toBeNull();
    expect(
      await kvGet(db, `${NOTIFICATION_ROUTE_KV_PREFIX}00000000-0000-4000-8000-000000000000`),
    ).toBeNull();
    expect(await kvGet(db, THEME_PREF_KEY)).toBe('gator');
    expect(await kvGet(db, SETTING_KEY)).toBe('25');
    expect(count(raw, 'contacts')).toBe(1);
  });

  it('is idempotent on an already-empty database', async () => {
    const { db } = await createTestDb();
    await clearLocalCache(db);
    await expect(clearLocalCache(db)).resolves.toBeUndefined();
  });

  it('does not start a wipe statement inside a rolling-back neighbouring transaction', async () => {
    const { db, raw } = await createTestDb();
    await setSyncMarker(db, { lastSyncedRowId: 7, lastSyncedTimestamp: 8 });
    raw
      .prepare(
        `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
         VALUES ('temp-committed', 'chat-committed', 'text', '{}')`,
      )
      .run();
    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(db, async (context) => {
      neighbourStarted();
      await release;
      throw new Error('neighbour rollback');
    });
    await started;

    let wipeSettled = false;
    const wipe = clearLocalCache(db).finally(() => {
      wipeSettled = true;
    });
    await Promise.resolve();
    expect(wipeSettled).toBe(false);
    expect(await getSyncMarker(db)).toEqual({ lastSyncedRowId: 7, lastSyncedTimestamp: 8 });
    expect(count(raw, 'outgoing_queue')).toBe(1);

    releaseNeighbour();
    await expect(neighbour).rejects.toThrow('neighbour rollback');
    await wipe;
    expect(await getSyncMarker(db)).toEqual({
      lastSyncedRowId: null,
      lastSyncedTimestamp: null,
    });
    expect(count(raw, 'outgoing_queue')).toBe(0);
  });

  it('keeps each deletion-ledger batch in queue order and awaits it before cache cleanup', async () => {
    const { db, raw } = await createTestDb();
    raw
      .prepare(
        `INSERT INTO message_guid_aliases (alias_guid, canonical_guid)
         VALUES ('temp-ledger-stage', 'real-ledger-stage')`,
      )
      .run();
    const insertLedger = raw.prepare(
      'INSERT INTO message_deletion_ledger (guid, date_deleted) VALUES (?, ?)',
    );
    raw.transaction(() => {
      for (let index = 0; index < 501; index += 1) {
        insertLedger.run(`ledger-stage-${index}`, 5_000 + index);
      }
    })();
    raw
      .prepare(
        `INSERT INTO attachment_cache_entries (path, bytes, last_used_at)
         VALUES ('file:///documents/attachments/ledger-stage', 1, 5000)`,
      )
      .run();

    type All = (query: unknown) => unknown;
    const realAll = db.all.bind(db) as All;
    const aliasDelete = driverGate();
    const firstLedgerDelete = driverGate();
    const secondLedgerDelete = driverGate();
    const cacheDelete = driverGate();
    const allSpy = jest.spyOn(db, 'all').mockImplementation(((query: unknown) => {
      const shape = JSON.stringify(query).replace(/\s+/g, ' ').toLowerCase();
      let gate: DriverGate | undefined;
      if (shape.includes('delete from message_guid_aliases') && shape.includes('returning rowid')) {
        gate = aliasDelete;
      } else if (
        shape.includes('delete from message_deletion_ledger') &&
        shape.includes('returning rowid')
      ) {
        gate = !firstLedgerDelete.didStart
          ? firstLedgerDelete
          : secondLedgerDelete.didStart
            ? undefined
            : secondLedgerDelete;
      } else if (
        shape.includes('delete from attachment_cache_entries') &&
        shape.includes('returning rowid')
      ) {
        gate = cacheDelete;
      }
      if (!gate || gate.didStart) return realAll(query);

      gate.didStart = true;
      const delayed = gate.held.then(() => realAll(query)).finally(gate.markFinished);
      // A dropped-await mutation must fail assertions, not leak an unhandled driver rejection.
      void delayed.catch(() => {});
      return delayed;
    }) as unknown as AppDatabase['all']);

    let releaseNeighbour!: () => void;
    const neighbourHeld = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    let neighbourDidStart = false;
    let wipeSettled = false;
    let wipeOutcome:
      Promise<{ kind: 'resolved'; value: void } | { kind: 'rejected'; error: unknown }> | undefined;
    let neighbourOutcome:
      | Promise<{ kind: 'resolved'; value: void } | { kind: 'rejected'; message: string }>
      | undefined;
    try {
      wipeOutcome = clearLocalCache(db)
        .then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        )
        .finally(() => {
          wipeSettled = true;
        });
      await waitForCondition(() => aliasDelete.didStart, 'message-guid-alias delete');
      expect(wipeSettled).toBe(false);
      expect(count(raw, 'message_guid_aliases')).toBe(1);
      expect(count(raw, 'message_deletion_ledger')).toBe(501);
      expect(count(raw, 'attachment_cache_entries')).toBe(1);

      neighbourOutcome = withDbTransaction(db, async (context) => {
        raw
          .prepare("INSERT INTO kv (key, value) VALUES ('cache.ledger.phantom', 'rollback')")
          .run();
        neighbourDidStart = true;
        await neighbourHeld;
        throw new Error('ledger neighbour rollback');
      }).then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, message: String(error) }),
      );

      aliasDelete.release();
      await aliasDelete.finished;
      await waitForCondition(() => neighbourDidStart, 'ledger neighbour transaction');
      await nextEventLoopTurn();
      expect(wipeSettled).toBe(false);
      expect(raw.inTransaction).toBe(true);
      expect(raw.prepare("SELECT value FROM kv WHERE key = 'cache.ledger.phantom'").get()).toEqual({
        value: 'rollback',
      });
      expect(count(raw, 'message_guid_aliases')).toBe(0);
      expect(count(raw, 'message_deletion_ledger')).toBe(501);
      expect(count(raw, 'attachment_cache_entries')).toBe(1);
      expect(firstLedgerDelete.didStart).toBe(false);
      expect(secondLedgerDelete.didStart).toBe(false);
      expect(cacheDelete.didStart).toBe(false);

      releaseNeighbour();
      await expect(neighbourOutcome).resolves.toEqual({
        kind: 'rejected',
        message: 'Error: ledger neighbour rollback',
      });
      expect(
        raw.prepare("SELECT value FROM kv WHERE key = 'cache.ledger.phantom'").get(),
      ).toBeUndefined();
      await waitForCondition(
        () => firstLedgerDelete.didStart,
        'first message-deletion-ledger delete',
      );
      await nextEventLoopTurn();
      expect(wipeSettled).toBe(false);
      expect(raw.inTransaction).toBe(false);
      expect(count(raw, 'message_deletion_ledger')).toBe(501);
      expect(count(raw, 'attachment_cache_entries')).toBe(1);
      expect(cacheDelete.didStart).toBe(false);

      firstLedgerDelete.release();
      await firstLedgerDelete.finished;
      await waitForCondition(
        () => secondLedgerDelete.didStart,
        'second message-deletion-ledger delete',
      );
      await nextEventLoopTurn();
      expect(wipeSettled).toBe(false);
      expect(raw.inTransaction).toBe(false);
      expect(count(raw, 'message_deletion_ledger')).toBe(1);
      expect(count(raw, 'attachment_cache_entries')).toBe(1);
      expect(cacheDelete.didStart).toBe(false);

      secondLedgerDelete.release();
      await secondLedgerDelete.finished;
      await waitForCondition(() => cacheDelete.didStart, 'attachment-cache successor delete');
      await nextEventLoopTurn();
      expect(wipeSettled).toBe(false);
      expect(raw.inTransaction).toBe(false);
      expect(count(raw, 'message_deletion_ledger')).toBe(0);
      expect(count(raw, 'attachment_cache_entries')).toBe(1);

      cacheDelete.release();
      await cacheDelete.finished;
      await expect(wipeOutcome).resolves.toEqual({ kind: 'resolved', value: undefined });
      expect(raw.inTransaction).toBe(false);
      expect(count(raw, 'message_guid_aliases')).toBe(0);
      expect(count(raw, 'message_deletion_ledger')).toBe(0);
      expect(count(raw, 'attachment_cache_entries')).toBe(0);
    } finally {
      aliasDelete.release();
      firstLedgerDelete.release();
      secondLedgerDelete.release();
      cacheDelete.release();
      releaseNeighbour();
      const drains: Promise<unknown>[] = [];
      if (wipeOutcome) drains.push(wipeOutcome);
      if (neighbourOutcome) drains.push(neighbourOutcome);
      if (aliasDelete.didStart) drains.push(aliasDelete.finished);
      if (firstLedgerDelete.didStart) drains.push(firstLedgerDelete.finished);
      if (secondLedgerDelete.didStart) drains.push(secondLedgerDelete.finished);
      if (cacheDelete.didStart) drains.push(cacheDelete.finished);
      await Promise.allSettled(drains);
      allSpy.mockRestore();
    }
  });

  it('releases the write queue after a mid-wipe SQL failure', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    raw.exec(`
      CREATE TABLE cache_wipe_message_blocker (
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE RESTRICT
      );
      INSERT INTO cache_wipe_message_blocker (message_id)
      SELECT id FROM messages ORDER BY id LIMIT 1
    `);
    expect(raw.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(count(raw, 'cache_wipe_message_blocker')).toBe(1);

    await expectForeignKeyRejection(clearLocalCache(db));
    // localCacheDirty takes the same queue. Resolving proves the failed delete released its slot;
    // true proves the caller will retry the intentionally partial wipe.
    await expect(localCacheDirty(db)).resolves.toBe(true);
  });

  it('commits at most 500 large-table rows per batch and resumes after interruption', async () => {
    const { db, raw } = await createTestDb();
    const insert = raw.prepare("INSERT INTO handles (address, service) VALUES (?, '')");
    raw.transaction(() => {
      for (let i = 0; i < 1205; i += 1) insert.run(`bulk-${i}@example.com`);
    })();
    raw.exec(`
      CREATE TABLE cache_wipe_handle_blocker (
        handle_id INTEGER NOT NULL REFERENCES handles(id) ON DELETE RESTRICT
      );
      INSERT INTO cache_wipe_handle_blocker (handle_id)
      SELECT id FROM handles ORDER BY rowid LIMIT 1 OFFSET 500
    `);
    expect(raw.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(count(raw, 'cache_wipe_handle_blocker')).toBe(1);

    await expectForeignKeyRejection(clearLocalCache(db));
    // The first 500-row statement committed. The blocker rejects batch two before any of its rows
    // can commit, so 705 rows remain and a restart has a clean boundary to resume from.
    expect(count(raw, 'handles')).toBe(705);

    raw.exec('DROP TABLE cache_wipe_handle_blocker');
    await clearLocalCache(db);
    expect(count(raw, 'handles')).toBe(0);
    await expect(localCacheDirty(db)).resolves.toBe(false);
  });

  it('batches scoped drafts without deleting global settings', async () => {
    const { db, raw } = await createTestDb();
    const insert = raw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)');
    raw.transaction(() => {
      for (let i = 0; i < 1205; i += 1) insert.run(`${DRAFT_KV_PREFIX}bulk-${i}`, `draft-${i}`);
      insert.run(SETTING_KEY, '25');
    })();
    raw.exec(`
      CREATE TABLE draft_wipe_blocker (
        key TEXT NOT NULL REFERENCES kv(key) ON DELETE RESTRICT
      );
      INSERT INTO draft_wipe_blocker (key)
      SELECT key FROM kv
       WHERE key LIKE '${DRAFT_KV_PREFIX}%'
       ORDER BY rowid
       LIMIT 1 OFFSET 500
    `);
    expect(raw.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(count(raw, 'draft_wipe_blocker')).toBe(1);

    await expectForeignKeyRejection(clearLocalCache(db));
    expect(
      (
        raw.prepare("SELECT COUNT(*) AS count FROM kv WHERE key LIKE 'draft.%'").get() as {
          count: number;
        }
      ).count,
    ).toBe(705);
    expect(await kvGet(db, SETTING_KEY)).toBe('25');

    raw.exec('DROP TABLE draft_wipe_blocker');
    await clearLocalCache(db);
    expect(await kvGet(db, SETTING_KEY)).toBe('25');
    await expect(localCacheDirty(db)).resolves.toBe(false);
  });

  /**
   * The wipe cannot be one SQL transaction because it deletes every message on the device. Its
   * statements commit independently, so a process death or an ordinary writer interleaving rows
   * can still leave a partial outcome. Either way the previous account's rows remain on the device;
   * `forget()` therefore CONFIRMS the wipe and re-runs it — this is the check it confirms with.
   */
  describe('localCacheDirty', () => {
    it('answers true for a populated device and false once the wipe lands', async () => {
      const { db } = await createTestDb();
      await seed(db);
      expect(await localCacheDirty(db)).toBe(true);

      await clearLocalCache(db);

      expect(await localCacheDirty(db)).toBe(false);
    });

    it('answers true when a surviving sync marker is the ONLY thing left', async () => {
      // The half-wipe that hurts most: rows gone, but the old server's ROWID cursor still in place,
      // so the next sync takes the incremental branch and never fetches the new server's history.
      const { db } = await createTestDb();
      await clearLocalCache(db);
      await setSyncMarker(db, { lastSyncedRowId: 7, lastSyncedTimestamp: 8 });

      expect(await localCacheDirty(db)).toBe(true);
    });

    it("waits for rollback instead of accepting a neighbour's uncommitted empty view", async () => {
      const { db, raw } = await createTestDb();
      await clearLocalCache(db);
      raw
        .prepare(
          `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
           VALUES ('temp-residue', 'chat-residue', 'text', '{}')`,
        )
        .run();

      let releaseNeighbour!: () => void;
      const neighbourHeld = new Promise<void>((resolve) => {
        releaseNeighbour = resolve;
      });
      let neighbourDidStart = false;
      const neighbourOutcome = withDbTransaction(db, async (context) => {
        raw.prepare("DELETE FROM outgoing_queue WHERE temp_guid = 'temp-residue'").run();
        neighbourDidStart = true;
        await neighbourHeld;
        throw new Error('neighbour rollback');
      }).then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, message: String(error) }),
      );
      let checkOutcome:
        | Promise<{ kind: 'resolved'; value: boolean } | { kind: 'rejected'; error: unknown }>
        | undefined;
      try {
        await waitForCondition(() => neighbourDidStart, 'dirty-check neighbour transaction');
        expect(count(raw, 'outgoing_queue')).toBe(0);

        let checkSettled = false;
        checkOutcome = localCacheDirty(db)
          .then(
            (value) => ({ kind: 'resolved' as const, value }),
            (error: unknown) => ({ kind: 'rejected' as const, error }),
          )
          .finally(() => {
            checkSettled = true;
          });
        await nextEventLoopTurn();
        expect(checkSettled).toBe(false);

        releaseNeighbour();
        await expect(neighbourOutcome).resolves.toEqual({
          kind: 'rejected',
          message: 'Error: neighbour rollback',
        });
        await expect(checkOutcome).resolves.toEqual({ kind: 'resolved', value: true });
        expect(count(raw, 'outgoing_queue')).toBe(1);
      } finally {
        releaseNeighbour();
        const drains: Promise<unknown>[] = [neighbourOutcome];
        if (checkOutcome) drains.push(checkOutcome);
        await Promise.allSettled(drains);
      }
    });

    it.each([
      ['attachment', `INSERT INTO attachments (guid) VALUES ('isolated-attachment')`],
      [
        'attachment cache ledger',
        `INSERT INTO attachment_cache_entries (path, bytes, last_used_at)
         VALUES ('file:///documents/attachments/isolated', 1, 1)`,
      ],
      [
        'outgoing send',
        `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
         VALUES ('temp-isolated', 'chat-isolated', 'text', '{}')`,
      ],
      [
        'scheduled message',
        `INSERT INTO scheduled_messages (chat_guid, payload, scheduled_for)
         VALUES ('chat-isolated', '{}', 9000)`,
      ],
      [
        'reminder',
        `INSERT INTO reminders (message_guid, chat_guid, scheduled_for, notification_id)
         VALUES ('message-isolated', 'chat-isolated', 9000, 'notification-isolated')`,
      ],
      ['URL preview', `INSERT INTO url_previews (url) VALUES ('https://isolated.example')`],
      [
        'error report',
        `INSERT INTO error_reports (level, message, created_at)
         VALUES ('error', 'isolated diagnostic', 5000)`,
      ],
      [
        'incoming event',
        `INSERT INTO incoming_event_queue
           (event_key, payload_digest, ordering_key, event_name, source, payload,
            received_at, expires_at)
         VALUES ('isolated-event', '${INCOMING_DIGEST}', 'isolated-order', 'new-message',
                 'fcm', '{}', 5000, 6000)`,
      ],
      [
        'message deletion ledger',
        `INSERT INTO message_deletion_ledger (guid, date_deleted)
         VALUES ('isolated-deleted-message', 5000)`,
      ],
      [
        'message GUID alias',
        `INSERT INTO message_guid_aliases (alias_guid, canonical_guid)
         VALUES ('temp-isolated-alias', 'real-isolated-alias')`,
      ],
      [
        'custom folder',
        `INSERT INTO custom_folders (name, sort_order) VALUES ('Isolated folder', 0)`,
      ],
      [
        'composer draft',
        `INSERT INTO kv (key, value) VALUES ('${DRAFT_KV_PREFIX}isolated', 'private draft')`,
      ],
      [
        'deletion watermark',
        `INSERT INTO kv (key, value) VALUES ('${DELETIONS_WATERMARK_KV_KEY}', '1234')`,
      ],
      [
        'notification route',
        `INSERT INTO kv (key, value)
         VALUES ('${NOTIFICATION_ROUTE_KV_PREFIX}00000000-0000-4000-8000-000000000000',
                 'old-account-call-uuid')`,
      ],
    ])('answers true when an isolated %s row survives', async (_label, insertSql) => {
      const { db, raw } = await createTestDb();
      await clearLocalCache(db);
      raw.prepare(insertSql).run();

      expect(await localCacheDirty(db)).toBe(true);
    });
  });

  it('targets the same kv key the deletion sync writes', () => {
    // db/ cannot import services/, so the key is duplicated — this is the guard that they agree.
    expect(DELETIONS_WATERMARK_KV_KEY).toBe(DELETIONS_SYNCED_AT_KEY);
  });
});
