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
  clearLocalCache,
  createReminder,
  getSyncMarker,
  insertErrorReport,
  insertOutgoingText,
  insertScheduled,
  kvGet,
  kvSet,
  localCacheDirty,
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
import { DELETIONS_SYNCED_AT_KEY } from '@/services/sync/engine';
import { createTestDb } from '../support/testDb';

const SETTING_KEY = 'sync.messagesPerChat';

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
  await insertErrorReport(db, {
    level: 'error',
    message: '[send] boom',
    stack: 'at send (send.ts:1)',
    tag: 'send',
    meta: null,
    createdAt: 5000,
  });

  await setSyncMarker(db, { lastSyncedRowId: 4321, lastSyncedTimestamp: 1000 });
  await kvSet(db, DELETIONS_WATERMARK_KV_KEY, '1234');
  // A per-chat composer draft — kv, but chat-scoped and keyed by a guid that repeats across
  // servers, so it must go with the chat row.
  await kvSet(db, `${DRAFT_KV_PREFIX}c1`, 'tell him I am leaving');

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

describe('clearLocalCache', () => {
  it('empties every server-derived table', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    expect(count(raw, 'messages')).toBeGreaterThan(0);

    await clearLocalCache(db);

    for (const table of [
      'attachments',
      'messages',
      'chat_handles',
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
    expect(await kvGet(db, THEME_PREF_KEY)).toBe('gator');
    expect(await kvGet(db, SETTING_KEY)).toBe('25');
    expect(count(raw, 'contacts')).toBe(1);
  });

  it('is idempotent on an already-empty database', async () => {
    const { db } = await createTestDb();
    await clearLocalCache(db);
    await expect(clearLocalCache(db)).resolves.toBeUndefined();
  });

  /**
   * The wipe cannot be one transaction (it deletes every message on the device, and the write lock
   * is process-wide), so a partial outcome is reachable AND silent: a statement swept into a
   * neighbour's rolled-back transaction throws nothing, and an FK error from a concurrent sync
   * slice re-inserting messages is caught and logged at `warn` by `forget()`. Either way the
   * previous account's rows are still on the device. `forget()` therefore CONFIRMS the wipe and
   * re-runs it — this is the check it confirms with.
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
  });

  it('targets the same kv key the deletion sync writes', () => {
    // db/ cannot import services/, so the key is duplicated — this is the guard that they agree.
    expect(DELETIONS_WATERMARK_KV_KEY).toBe(DELETIONS_SYNCED_AT_KEY);
  });
});
