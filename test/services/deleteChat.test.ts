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
 *   - Neither of those may ever cost the user the delete itself.
 *   - The DB is opened with the lazy `ensureDatabase()`.
 *
 * The DB is REAL (in-memory better-sqlite3); everything native/network is mocked at the module
 * boundary, mirroring `markUnread.test.ts`.
 */
import { Chat } from '@core/models';
import {
  createReminder,
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
const mockDeleteScheduled = jest.fn<Promise<unknown>, [unknown, string]>();

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

beforeEach(() => {
  mockCancelReminder.mockReset().mockResolvedValue(undefined);
  mockDeleteScheduled.mockReset().mockResolvedValue({ removed: true });
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
});
