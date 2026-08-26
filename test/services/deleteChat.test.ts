/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
/**
 * Unit tests for `deleteChat` (`src/services/chatActions.ts`) — the service wrapper the UI's
 * "Delete Conversation" goes through.
 *
 * The wrapper exists for the reasons the repository can't cover: this chat's state that lives
 * OUTSIDE the database and keeps acting on its own once the rows are gone.
 *
 *   - A reminder's trigger notification is OS state that outlives its row: uncancelled it still
 *     fires hours later, showing the deleted message's preview on the lock screen and deep-linking
 *     into a conversation that is no longer in the inbox. Cancel first (the ids are unrecoverable
 *     afterwards), and keep the row of any alarm we could NOT cancel — deleting it makes that alarm
 *     permanently unfindable.
 *   - A SERVER-backed scheduled message is fired by the Mac, so dropping the local row cancels
 *     nothing; it just destroys the handle needed to cancel it. Cancel server-side first, and keep
 *     the row when the server refuses.
 *   - A posted TRAY notification is system state keyed by the chat guid: left up it still shows the
 *     deleted conversation's sender and preview, and tapping it routes back into the hidden thread.
 *   - Ledger-managed downloaded files are retired by exact physical path. Pre-ledger GUID
 *     directories are NEVER recursively removed here: forwarding may give another message a
 *     different attachment GUID while it still shares a file inside the source GUID's directory.
 *     Bounded startup discovery adopts or exactly retires those legacy files later.
 *   - None of those may ever cost the user the delete itself.
 *   - The DB is opened with the lazy `ensureDatabase()`.
 *
 * The DB is REAL (in-memory better-sqlite3); everything native/network is mocked at the module
 * boundary, mirroring `markUnread.test.ts`.
 */
import type Database from 'better-sqlite3';
import { Chat } from '@core/models';
import { logger } from '@core/secure';
import {
  createReminder,
  getAttachmentCacheEntry,
  getChatIdByGuid,
  insertScheduled,
  listChatsForInbox,
  listReminders,
  listScheduledByChat,
  recordAttachmentCacheEntry,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { deleteNativeAttachmentCacheFile } from '@native/boundedDownload';
import { createTestDb } from '../support/testDb';

// Hoisted jest.mock factories may only reference `mock`-prefixed vars.
let mockDb: AppDatabase;
const mockCancelReminder = jest.fn<Promise<void>, [string]>();
const mockCancelForChat = jest.fn<Promise<void>, [string]>();
const mockDeleteScheduled = jest.fn<Promise<unknown>, [unknown, string]>();
const mockCancelAttachmentDownloads = jest.fn<void, [Iterable<string>, number | undefined]>();
/** Broad directories removed by the delete. This must remain empty. */
const mockDeletedDirs: string[] = [];

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/clients', () => ({ http: { __http: true } }));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: jest.fn(async () => mockDb) }));
jest.mock('@/services/realtimeControl', () => ({ getSocket: jest.fn(() => null) }));
jest.mock('@/services/download/downloadService', () => ({
  cancelAttachmentDownloads: (guids: Iterable<string>, generation?: number) =>
    mockCancelAttachmentDownloads(guids, generation),
}));
jest.mock('@state/featureSettingsStore', () => ({
  useFeatureSettingsStore: {
    getState: () => ({ privateApiEnabled: true, sendReadReceipts: true, hydrated: true }),
  },
}));
jest.mock('@core/api', () => ({
  chatsApi: {},
  scheduledApi: { deleteScheduled: (http: unknown, id: string) => mockDeleteScheduled(http, id) },
}));
jest.mock('@/services/notifications/notifeeService', () => ({
  cancelReminderNotification: (id: string) => mockCancelReminder(id),
  cancelForChat: (guid: string) => mockCancelForChat(guid),
}));
// A regression sentinel for the old recursive GUID-directory cleanup. The service should not load
// or invoke it; if broad cleanup is reintroduced, these tests record the destructive targets.
jest.mock('expo-file-system', () => ({
  Paths: { document: '/doc' },
  Directory: class {
    path: string;
    exists = true;
    constructor(...segments: string[]) {
      this.path = segments.join('/');
    }
    delete(): void {
      mockDeletedDirs.push(this.path);
    }
  },
}));

import { deleteChat } from '@/services/chatActions';
import { ensureDatabase } from '@/services/databaseControl';
import { attachmentCacheCoordinator } from '@/services/download/attachmentCacheCoordinator';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function seedChat(db: AppDatabase, guid: string): Promise<void> {
  const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
  await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
}

async function seedReminder(db: AppDatabase, chatGuid: string, id: string): Promise<void> {
  await createReminder(db, {
    messageGuid: `msg-${id}`,
    chatGuid,
    messagePreview: 'private text',
    senderName: 'Alice',
    scheduledFor: 9_000,
    notificationId: id,
  });
}

/**
 * A downloaded attachment: a message in `chatGuid` plus its `attachments` row carrying the
 * `local_path` that `expoFetcher` wrote. Raw SQL — the point is the row the purge cascades away.
 */
async function seedDownloadedAttachment(
  db: AppDatabase,
  raw: Database.Database,
  chatGuid: string,
  messageGuid: string,
  attachmentGuid: string,
  localPath: string | null = `/doc/attachments/${attachmentGuid}/IMG_0001.jpg`,
): Promise<void> {
  const chatId = await getChatIdByGuid(db, chatGuid);
  raw
    .prepare(
      'INSERT INTO messages (guid, chat_id, text, is_from_me, date_created) VALUES (?,?,?,0,1000)',
    )
    .run(messageGuid, chatId, 'photo');
  const { id } = raw.prepare('SELECT id FROM messages WHERE guid = ?').get(messageGuid) as {
    id: number;
  };
  raw
    .prepare('INSERT INTO attachments (guid, message_id, local_path) VALUES (?,?,?)')
    .run(attachmentGuid, id, localPath);
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  mockCancelReminder.mockReset().mockResolvedValue(undefined);
  mockCancelForChat.mockReset().mockResolvedValue(undefined);
  mockDeleteScheduled.mockReset().mockResolvedValue({ removed: true });
  mockCancelAttachmentDownloads.mockReset();
  (deleteNativeAttachmentCacheFile as jest.Mock).mockReset().mockResolvedValue({
    status: 'deleted',
    bytes: 1,
  });
  mockDeletedDirs.length = 0;
  (ensureDatabase as jest.Mock).mockClear();
});

afterEach(() => {
  resumeRealtimeDeliveries();
});

describe('deleteChat', () => {
  it('passes one account cache scope through both cleanup phases', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    const retire = jest
      .spyOn(attachmentCacheCoordinator, 'retireInactiveEntries')
      .mockResolvedValue({
        status: 'complete',
        attempted: 0,
        confirmed: 0,
        failed: 0,
        skipped: 0,
      });
    const drain = jest.spyOn(attachmentCacheCoordinator, 'drainDueRetirements').mockResolvedValue({
      status: 'complete',
      attempted: 0,
      confirmed: 0,
      failed: 0,
      skipped: 0,
    });
    const lease = captureRealtimeDeliveryLease();
    try {
      await deleteChat('c1', lease);

      expect(retire).toHaveBeenCalledTimes(2);
      expect(drain).toHaveBeenCalledTimes(2);
      const scope = retire.mock.calls[0]?.[1]?.scope;
      expect(scope).toBeDefined();
      expect(scope?.generation).toBe(lease.generation);
      expect(retire.mock.calls[1]?.[1]?.scope).toBe(scope);
      expect(drain.mock.calls[0]?.[1]?.scope).toBe(scope);
      expect(drain.mock.calls[1]?.[1]?.scope).toBe(scope);
    } finally {
      retire.mockRestore();
      drain.mockRestore();
      raw.close();
    }
  });

  it('rolls back a queued inactive claim after account revocation and lets a fresh delete retry', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'cache-revoke-a');
    await seedChat(db, 'cache-revoke-b');
    await seedChat(db, 'cache-orphan');
    const inactive = '/doc/attachments/cache-orphan/shared.jpg';
    await seedDownloadedAttachment(
      db,
      raw,
      'cache-orphan',
      'cache-orphan-message-a',
      'cache-orphan-att-a',
      inactive,
    );
    await seedDownloadedAttachment(
      db,
      raw,
      'cache-orphan',
      'cache-orphan-message-b',
      'cache-orphan-att-b',
      inactive,
    );
    raw
      .prepare(
        `UPDATE messages SET date_deleted = 2
         WHERE guid IN ('cache-orphan-message-a', 'cache-orphan-message-b')`,
      )
      .run();
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: inactive, bytes: 20, lastUsedAt: 1 }),
    );

    const neighbourStarted = deferred<void>();
    const releaseNeighbour = deferred<void>();
    const originalRetire = attachmentCacheCoordinator.retireInactiveEntries.bind(
      attachmentCacheCoordinator,
    );
    let neighbour: Promise<unknown> | undefined;
    let oldDelete: Promise<void> | undefined;
    let pause: Promise<void> | undefined;
    const retire = jest.spyOn(attachmentCacheCoordinator, 'retireInactiveEntries');
    retire.mockImplementationOnce(async (cacheDb, input) => {
      neighbour = withDbTransaction(db, async (context) => {
        raw.prepare("INSERT INTO kv (key, value) VALUES ('cache-revoke-neighbour', 'dirty')").run();
        neighbourStarted.resolve(undefined);
        await releaseNeighbour.promise;
        throw new Error('cache revocation neighbour rollback');
      }).catch((error: unknown) => error);
      await neighbourStarted.promise;
      return originalRetire(cacheDb, input);
    });
    (deleteNativeAttachmentCacheFile as jest.Mock).mockImplementation(async (candidate: string) => {
      expect(candidate).toBe(inactive);
      expect(raw.inTransaction).toBe(false);
      expect(await getAttachmentCacheEntry(db, inactive)).toMatchObject({ state: 'retiring' });
      expect(
        raw
          .prepare(
            `SELECT guid, local_path AS localPath
             FROM attachments WHERE guid LIKE 'cache-orphan-att-%' ORDER BY guid`,
          )
          .all(),
      ).toEqual([
        { guid: 'cache-orphan-att-a', localPath: null },
        { guid: 'cache-orphan-att-b', localPath: null },
      ]);
      return { status: 'deleted', bytes: 20 };
    });

    try {
      oldDelete = deleteChat('cache-revoke-a', captureRealtimeDeliveryLease());
      await neighbourStarted.promise;

      let pauseSettled = false;
      pause = pauseRealtimeDeliveries().then(() => {
        pauseSettled = true;
      });
      await Promise.resolve();
      expect(pauseSettled).toBe(false);
      resumeRealtimeDeliveries();
      releaseNeighbour.resolve(undefined);

      await neighbour;
      await expect(oldDelete).resolves.toBeUndefined();
      await pause;
      expect(await getAttachmentCacheEntry(db, inactive)).toMatchObject({ state: 'active' });
      expect(
        raw
          .prepare(
            `SELECT guid, local_path AS localPath
             FROM attachments WHERE guid LIKE 'cache-orphan-att-%' ORDER BY guid`,
          )
          .all(),
      ).toEqual([
        { guid: 'cache-orphan-att-a', localPath: inactive },
        { guid: 'cache-orphan-att-b', localPath: inactive },
      ]);
      expect(deleteNativeAttachmentCacheFile).not.toHaveBeenCalled();
      expect(
        raw.prepare("SELECT value FROM kv WHERE key = 'cache-revoke-neighbour'").get(),
      ).toBeUndefined();

      await deleteChat('cache-revoke-b', captureRealtimeDeliveryLease());
      expect(deleteNativeAttachmentCacheFile).toHaveBeenCalledTimes(1);
      expect(await getAttachmentCacheEntry(db, inactive)).toBeNull();
    } finally {
      releaseNeighbour.resolve(undefined);
      await Promise.allSettled(
        [neighbour, oldDelete, pause].filter(Boolean) as Array<Promise<unknown>>,
      );
      retire.mockRestore();
      raw.close();
    }
  });

  it('quietly rejects a delayed confirmation callback carrying an old screen lease', async () => {
    const accountALease = captureRealtimeDeliveryLease();
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();

    const accountB = await createTestDb();
    mockDb = accountB.db;
    await seedChat(accountB.db, 'same-guid');

    await expect(deleteChat('same-guid', accountALease)).resolves.toBeUndefined();

    expect(ensureDatabase).not.toHaveBeenCalled();
    expect((await listChatsForInbox(accountB.db)).map((row) => row.guid)).toEqual(['same-guid']);
  });

  it('does not let an A-account delete parked on DB open tombstone B’s same-guid row', async () => {
    const accountB = await createTestDb();
    await seedChat(accountB.db, 'same-guid');
    const opening = deferred<AppDatabase>();
    (ensureDatabase as jest.Mock).mockImplementationOnce(() => opening.promise);

    const oldDelete = deleteChat('same-guid');
    expect(ensureDatabase).toHaveBeenCalledTimes(1);
    let pauseSettled = false;
    const pause = pauseRealtimeDeliveries().then(() => {
      pauseSettled = true;
    });
    mockDb = accountB.db;
    await Promise.resolve();
    expect(pauseSettled).toBe(false);

    opening.resolve(accountB.db);
    await expect(oldDelete).resolves.toBeUndefined();
    await pause;
    resumeRealtimeDeliveries();

    expect((await listChatsForInbox(accountB.db)).map((row) => row.guid)).toEqual(['same-guid']);
    expect(mockCancelForChat).not.toHaveBeenCalled();
    expect(mockCancelReminder).not.toHaveBeenCalled();
    expect(mockDeleteScheduled).not.toHaveBeenCalled();
  });

  it('cancels only the target chat’s reminder alarms, then deletes its rows', async () => {
    const { db } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    await seedChat(db, 'c2');
    await seedReminder(db, 'c1', 'r-a');
    await seedReminder(db, 'c1', 'r-b');
    await seedReminder(db, 'c2', 'r-other');

    await deleteChat('c1');

    expect(mockCancelReminder.mock.calls.map((c) => c[0]).sort()).toEqual(['r-a', 'r-b']);
    expect((await listReminders(db)).map((r) => r.notificationId)).toEqual(['r-other']);
  });

  it('rolls back the post-native reminder-row delete when the account retires, then lets a fresh delete retry', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    await seedReminder(db, 'c1', 'r-a');

    let nativeCancelCompleted = false;
    let nativeCancelRanInsideTransaction = false;
    mockCancelReminder.mockImplementation(async () => {
      nativeCancelRanInsideTransaction = raw.inTransaction;
      nativeCancelCompleted = true;
    });

    let drain: Promise<void> | undefined;
    let triggerRan = false;
    let nativeWasCancelledFirst = false;
    raw.function('pause_chat_delete_reminder_during_delete', () => {
      triggerRan = true;
      nativeWasCancelledFirst = nativeCancelCompleted;
      drain = pauseRealtimeDeliveries();
      return 0;
    });
    raw.exec(`
      CREATE TRIGGER pause_chat_delete_reminder_during_delete
      AFTER DELETE ON reminders
      WHEN OLD.notification_id = 'r-a'
      BEGIN
        SELECT pause_chat_delete_reminder_during_delete();
      END
    `);

    try {
      await expect(deleteChat('c1', captureRealtimeDeliveryLease())).resolves.toBeUndefined();
      if (!drain) throw new Error('reminder-row delete did not retire the account lease');
      await drain;

      expect(triggerRan).toBe(true);
      expect(nativeCancelRanInsideTransaction).toBe(false);
      expect(nativeWasCancelledFirst).toBe(true);
      expect((await listReminders(db)).map((reminder) => reminder.notificationId)).toEqual(['r-a']);

      raw.exec('DROP TRIGGER pause_chat_delete_reminder_during_delete');
      resumeRealtimeDeliveries();
      await deleteChat('c1');

      expect(mockCancelReminder.mock.calls.map((call) => call[0])).toEqual(['r-a', 'r-a']);
      expect(await listReminders(db)).toHaveLength(0);
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS pause_chat_delete_reminder_during_delete');
      resumeRealtimeDeliveries();
    }
  });

  it('cancels BEFORE the rows go — otherwise the ids are unrecoverable', async () => {
    const { db } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    await seedReminder(db, 'c1', 'r-a');
    let rowsAtCancelTime = -1;
    mockCancelReminder.mockImplementation(async () => {
      rowsAtCancelTime = (await listReminders(db)).length;
    });

    await deleteChat('c1');

    expect(rowsAtCancelTime).toBe(1);
    expect(await listReminders(db)).toHaveLength(0);
  });

  it('still deletes the chat when the native notification bridge fails — and KEEPS the reminder row', async () => {
    const { db } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    await seedReminder(db, 'c1', 'r-a');
    mockCancelReminder.mockRejectedValue(new Error('no native module'));

    await expect(deleteChat('c1')).resolves.toBeUndefined();

    // The alarm is still armed. Dropping the row would make it unstoppable — `listReminders` is
    // how both the Reminders screen and `forget()` find triggers to cancel.
    expect((await listReminders(db)).map((r) => r.notificationId)).toEqual(['r-a']);
  });

  it('keeps only the reminders whose cancellation failed', async () => {
    const { db } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    await seedReminder(db, 'c1', 'r-ok');
    await seedReminder(db, 'c1', 'r-bad');
    mockCancelReminder.mockImplementation(async (id) => {
      if (id === 'r-bad') throw new Error('trigger unreachable');
    });

    await deleteChat('c1');

    // One unreachable trigger must not cost the other reminder its delete (allSettled, not all).
    expect((await listReminders(db)).map((r) => r.notificationId)).toEqual(['r-bad']);
  });

  it('does not touch the notification bridge for a chat with no reminders', async () => {
    const { db } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');

    await deleteChat('c1');

    expect(mockCancelReminder).not.toHaveBeenCalled();
  });

  it('cancels a SERVER-backed scheduled message on the Mac before dropping its row', async () => {
    const { db } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    await seedChat(db, 'c2');
    await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'fires tomorrow',
      scheduledFor: 9_000,
      serverId: 'srv-1',
    });
    await insertScheduled(db, { chatGuid: 'c1', text: 'local only', scheduledFor: 9_000 });
    await insertScheduled(db, {
      chatGuid: 'c2',
      text: 'other chat',
      scheduledFor: 9_000,
      serverId: 'srv-2',
    });

    await deleteChat('c1');

    // ONLY the deleted chat's server-backed row is cancelled server-side…
    expect(mockDeleteScheduled.mock.calls.map((c) => c[1])).toEqual(['srv-1']);
    // …and both of c1's rows are gone, while c2's is untouched.
    expect(await listScheduledByChat(db, 'c1')).toHaveLength(0);
    expect(await listScheduledByChat(db, 'c2')).toHaveLength(1);
  });

  it('rolls back the post-server scheduled-row delete when the account retires, then lets a fresh delete retry', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'server already cancelled; retain the local retry handle',
      scheduledFor: 9_000,
      serverId: 'srv-1',
    });

    let serverDeleteCompleted = false;
    let serverDeleteRanInsideTransaction = false;
    mockDeleteScheduled.mockImplementation(async () => {
      serverDeleteRanInsideTransaction = raw.inTransaction;
      serverDeleteCompleted = true;
      return { removed: true };
    });

    let drain: Promise<void> | undefined;
    let triggerRan = false;
    let serverWasDeletedFirst = false;
    raw.function('pause_chat_delete_scheduled_during_delete', () => {
      triggerRan = true;
      serverWasDeletedFirst = serverDeleteCompleted;
      drain = pauseRealtimeDeliveries();
      return 0;
    });
    raw.exec(`
      CREATE TRIGGER pause_chat_delete_scheduled_during_delete
      AFTER DELETE ON scheduled_messages
      WHEN OLD.id = ${id}
      BEGIN
        SELECT pause_chat_delete_scheduled_during_delete();
      END
    `);

    try {
      await expect(deleteChat('c1', captureRealtimeDeliveryLease())).resolves.toBeUndefined();
      if (!drain) throw new Error('scheduled-row delete did not retire the account lease');
      await drain;

      expect(triggerRan).toBe(true);
      expect(serverDeleteRanInsideTransaction).toBe(false);
      expect(serverWasDeletedFirst).toBe(true);
      expect((await listScheduledByChat(db, 'c1')).map((row) => row.id)).toEqual([id]);

      raw.exec('DROP TRIGGER pause_chat_delete_scheduled_during_delete');
      resumeRealtimeDeliveries();
      await deleteChat('c1');

      expect(mockDeleteScheduled.mock.calls.map((call) => call[1])).toEqual(['srv-1', 'srv-1']);
      expect(await listScheduledByChat(db, 'c1')).toHaveLength(0);
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS pause_chat_delete_scheduled_during_delete');
      resumeRealtimeDeliveries();
    }
  });

  it('KEEPS a server-backed scheduled row the server refused to cancel, and still deletes the chat', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'fires tomorrow',
      scheduledFor: 9_000,
      serverId: 'srv-1',
    });
    const failure = new Error('offline');
    mockDeleteScheduled.mockRejectedValue(failure);

    await expect(deleteChat('c1')).resolves.toBeUndefined();

    // The Mac will still send it, so the row is the user's only handle to cancel it — the
    // Scheduled screen lists pending rows without joining `chats`, so a hidden chat keeps it usable.
    expect((await listScheduledByChat(db, 'c1')).map((r) => r.serverId)).toEqual(['srv-1']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[chats] server scheduled-message cancel failed; keeping the local row',
      failure,
    );
    warn.mockRestore();
  });

  it('deletes locally BEFORE any network round trip — the tile must not wait on a hung server', async () => {
    const { db } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'fires tomorrow',
      scheduledFor: 9_000,
      serverId: 'srv-1',
    });
    // Both list call sites are `void deleteChat(...)` with no spinner, so anything awaited ahead of
    // the local delete is time the row sits in the inbox looking like the tap did nothing — and
    // against a server that accepts the connection then blackholes it, that is a full request
    // timeout per scheduled row.
    let visibleWhenServerCalled = -1;
    mockDeleteScheduled.mockImplementation(async () => {
      visibleWhenServerCalled = (await listChatsForInbox(db)).length;
      return { removed: true };
    });

    await deleteChat('c1');

    expect(visibleWhenServerCalled).toBe(0);
    // …and the server-backed row is still cancelled: deleteChatLocal deliberately leaves it.
    expect(mockDeleteScheduled.mock.calls.map((c) => c[1])).toEqual(['srv-1']);
    expect(await listScheduledByChat(db, 'c1')).toHaveLength(0);
  });

  it('does not call the server for a chat whose scheduled messages are all local-only', async () => {
    const { db } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    await insertScheduled(db, { chatGuid: 'c1', text: 'local only', scheduledFor: 9_000 });

    await deleteChat('c1');

    expect(mockDeleteScheduled).not.toHaveBeenCalled();
    expect(await listScheduledByChat(db, 'c1')).toHaveLength(0);
  });

  // The notification is posted with `id = chatGuid` and nothing else on the delete path touches it.
  // Left in the tray it keeps showing the deleted conversation's sender and message preview, and
  // tapping it deep-links straight back into the thread the user just removed.
  it('dismisses the deleted chat’s tray notification — before any network round trip', async () => {
    const { db } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'fires tomorrow',
      scheduledFor: 9_000,
      serverId: 'srv-1',
    });
    let cancelledBeforeServer = false;
    mockDeleteScheduled.mockImplementation(async () => {
      cancelledBeforeServer = mockCancelForChat.mock.calls.length > 0;
      return { removed: true };
    });

    await deleteChat('c1');

    expect(mockCancelForChat.mock.calls.map((c) => c[0])).toEqual(['c1']);
    // A blackholing tunnel costs a full request timeout per scheduled row; the notification for a
    // deleted conversation must not sit there for it.
    expect(cancelledBeforeServer).toBe(true);
  });

  it('still deletes the chat when the notification bridge is unreachable', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    const failure = new Error('no native module');
    mockCancelForChat.mockRejectedValue(failure);

    await expect(deleteChat('c1')).resolves.toBeUndefined();

    expect(await listChatsForInbox(db)).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[chats] tray notification cancel failed for deleted chat',
      failure,
    );
    warn.mockRestore();
  });

  it('never recursively deletes legacy GUID directories when another chat shares the same file', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    await seedChat(db, 'c2');
    const sharedPath = '/doc/attachments/att-1/IMG_0001.jpg';
    await seedDownloadedAttachment(db, raw, 'c1', 'm-photo', 'att-1', sharedPath);
    await seedDownloadedAttachment(db, raw, 'c1', 'm-video', 'att-2');
    // Forwarding creates a new attachment GUID but deliberately reuses the physical source URI.
    await seedDownloadedAttachment(db, raw, 'c2', 'm-forward', 'att-forward', sharedPath);

    await deleteChat('c1');

    expect(mockDeletedDirs).toEqual([]);
    expect(
      raw.prepare('SELECT local_path AS path FROM attachments WHERE guid = ?').get('att-forward'),
    ).toEqual({ path: sharedPath });
  });

  it('cancels both downloaded and null-path attachment flights before purging the chat', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    await seedDownloadedAttachment(db, raw, 'c1', 'm-downloaded', 'att-downloaded');
    await seedDownloadedAttachment(db, raw, 'c1', 'm-in-flight', 'att-in-flight', null);
    const lease = captureRealtimeDeliveryLease();

    await deleteChat('c1', lease);

    expect(mockCancelAttachmentDownloads).toHaveBeenCalledTimes(1);
    const [guids, generation] = mockCancelAttachmentDownloads.mock.calls[0]!;
    expect([...guids]).toEqual(['att-downloaded', 'att-in-flight']);
    expect(generation).toBe(lease.generation);
  });

  it('deletes a ledger-managed file by exact path and never recursively removes its directory', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    const cachePath =
      'file:///documents/attachments/media-att-managed/generation-1/media-photo.jpg';
    await seedDownloadedAttachment(db, raw, 'c1', 'm-managed', 'att-managed', cachePath);
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: cachePath, bytes: 1234, lastUsedAt: 100 }),
    );

    await deleteChat('c1');

    expect(deleteNativeAttachmentCacheFile).toHaveBeenCalledWith(cachePath);
    expect(await getAttachmentCacheEntry(db, cachePath)).toBeNull();
    expect(mockDeletedDirs).toEqual([]);
  });

  it('does not broad-delete a legacy file when an attachment row survives the delete', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    await seedDownloadedAttachment(db, raw, 'c1', 'm-photo', 'att-1');
    // The purge is bounded at the tombstone stamp and yields the write lock between chunks, so a
    // row really can outlive it — and it still renders its image. Simulate that interleaving to
    // prove chat deletion never falls back to recursive filesystem cleanup.
    const realPrepare = raw.prepare.bind(raw);
    (raw as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => {
      if (/DELETE\s+FROM\s+messages\b/i.test(s)) {
        (raw as unknown as { prepare: unknown }).prepare = realPrepare;
        const stmt = realPrepare(s);
        return {
          all: (...args: unknown[]) => {
            const rows = (stmt as unknown as { all: (...a: unknown[]) => unknown[] }).all(...args);
            raw
              .prepare('INSERT INTO attachments (guid, message_id, local_path) VALUES (?,NULL,?)')
              .run('att-1', '/doc/attachments/att-1/IMG_0001.jpg');
            return rows;
          },
        };
      }
      return realPrepare(s);
    };
    try {
      await deleteChat('c1');
    } finally {
      (raw as unknown as { prepare: unknown }).prepare = realPrepare;
    }

    // The row really is still there…
    expect(raw.prepare('SELECT COUNT(*) c FROM attachments WHERE guid = ?').get('att-1')).toEqual({
      c: 1,
    });
    // …so its file stays: recursive cleanup would leave this row rendering a broken image.
    expect(mockDeletedDirs).toEqual([]);
  });

  // The purge yields the process-wide write lock between chunks, so it can die part-way — and
  // nothing else in the app ever re-enters it. The leftovers are invisible under the tombstone, so
  // the user cannot even see them to delete them again; they come back the day the chat revives.
  it('finishes a purge whose chunk failed, leaving no orphaned history behind', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    const chatId = await getChatIdByGuid(db, 'c1');
    const ins = raw.prepare(
      'INSERT INTO messages (guid, chat_id, text, is_from_me, date_created) VALUES (?,?,?,0,?)',
    );
    raw.transaction(() => {
      for (let i = 0; i < 700; i++) ins.run(`m${i}`, chatId, 'x', 1000 + i);
    })();

    // Chunk 1 commits, chunk 2 dies — then the "process is back" and nothing else is sabotaged.
    let deletes = 0;
    const realPrepare = raw.prepare.bind(raw);
    (raw as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => {
      if (/DELETE\s+FROM\s+messages\b/i.test(s) && ++deletes === 2) {
        (raw as unknown as { prepare: unknown }).prepare = realPrepare;
        throw new Error('chunk failed');
      }
      return realPrepare(s);
    };
    try {
      await expect(deleteChat('c1')).rejects.toThrow('chunk failed');
    } finally {
      (raw as unknown as { prepare: unknown }).prepare = realPrepare;
    }

    expect(raw.prepare('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 0 });
  });

  it('does not reach the filesystem for a chat with no downloaded attachments', async () => {
    const { db } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');

    await deleteChat('c1');

    expect(mockDeletedDirs).toEqual([]);
  });
});
