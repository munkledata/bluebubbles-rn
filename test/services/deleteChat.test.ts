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
 *   - Downloaded attachment FILES are only findable through `attachments.local_path`, which cascades
 *     away with the messages — so they must be collected before the delete and removed after it,
 *     and only where the row really did go.
 *   - None of those may ever cost the user the delete itself.
 *   - The DB is opened with the lazy `ensureDatabase()`.
 *
 * The DB is REAL (in-memory better-sqlite3); everything native/network is mocked at the module
 * boundary, mirroring `markUnread.test.ts`.
 */
import type Database from 'better-sqlite3';
import { Chat } from '@core/models';
import {
  createReminder,
  getChatIdByGuid,
  insertScheduled,
  listChatsForInbox,
  listReminders,
  listScheduledByChat,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

// Hoisted jest.mock factories may only reference `mock`-prefixed vars.
let mockDb: AppDatabase;
const mockCancelReminder = jest.fn<Promise<void>, [string]>();
const mockCancelForChat = jest.fn<Promise<void>, [string]>();
const mockDeleteScheduled = jest.fn<Promise<unknown>, [unknown, string]>();
/** Directories the delete removed, in order — `{documents}/attachments/<attachment guid>`. */
const mockDeletedDirs: string[] = [];

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/clients', () => ({ http: { __http: true } }));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: jest.fn(async () => mockDb) }));
jest.mock('@/services/realtimeControl', () => ({ getSocket: jest.fn(() => null) }));
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
// The filesystem half of the delete. `exists` is true so every candidate directory reaches
// `delete()` and the assertions are about WHICH ones the service decided to remove.
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
    .run(attachmentGuid, id, `/doc/attachments/${attachmentGuid}/IMG_0001.jpg`);
}

beforeEach(() => {
  mockCancelReminder.mockReset().mockResolvedValue(undefined);
  mockCancelForChat.mockReset().mockResolvedValue(undefined);
  mockDeleteScheduled.mockReset().mockResolvedValue({ removed: true });
  mockDeletedDirs.length = 0;
});

describe('deleteChat', () => {
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

  it('KEEPS a server-backed scheduled row the server refused to cancel, and still deletes the chat', async () => {
    const { db } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'fires tomorrow',
      scheduledFor: 9_000,
      serverId: 'srv-1',
    });
    mockDeleteScheduled.mockRejectedValue(new Error('offline'));

    await expect(deleteChat('c1')).resolves.toBeUndefined();

    // The Mac will still send it, so the row is the user's only handle to cancel it — the
    // Scheduled screen lists pending rows without joining `chats`, so a hidden chat keeps it usable.
    expect((await listScheduledByChat(db, 'c1')).map((r) => r.serverId)).toEqual(['srv-1']);
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
    const { db } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    mockCancelForChat.mockRejectedValue(new Error('no native module'));

    await expect(deleteChat('c1')).resolves.toBeUndefined();

    expect(await listChatsForInbox(db)).toHaveLength(0);
  });

  it('deletes the downloaded attachment files the purge orphaned, and only those', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    await seedChat(db, 'c2');
    await seedDownloadedAttachment(db, raw, 'c1', 'm-photo', 'att-1');
    await seedDownloadedAttachment(db, raw, 'c1', 'm-video', 'att-2');
    await seedDownloadedAttachment(db, raw, 'c2', 'm-other', 'att-other');

    await deleteChat('c1');

    // Their rows cascaded away with the messages, so nothing could ever find these files again —
    // `local_path` was the only record that the download happened.
    expect(mockDeletedDirs.sort()).toEqual(['/doc/attachments/att-1', '/doc/attachments/att-2']);
    // Another conversation's photos are untouched.
    expect(mockDeletedDirs).not.toContain('/doc/attachments/att-other');
  });

  it('leaves a file alone when its attachment row SURVIVED the delete', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    await seedChat(db, 'c1');
    await seedDownloadedAttachment(db, raw, 'c1', 'm-photo', 'att-1');
    // The purge is bounded at the tombstone stamp and yields the write lock between chunks, so a
    // row really can outlive it — and it still renders its image. Simulated by re-inserting the
    // row the cascade removed, which is the state the file deleter must re-check for.
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

    // The row really is still there (that is what the re-check has to notice)…
    expect(raw.prepare('SELECT COUNT(*) c FROM attachments WHERE guid = ?').get('att-1')).toEqual({
      c: 1,
    });
    // …so its file stays: deleting it leaves a message rendering a permanently broken image.
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
