import type Database from 'better-sqlite3';
import { Chat, Message } from '@core/models';
import {
  clearChatTombstone,
  createReminder,
  deleteChatLocal,
  findChatByParticipantAddresses,
  getChatHeader,
  getChatIdByGuid,
  insertOutgoingText,
  insertScheduled,
  kvGet,
  kvSet,
  listChatsForInbox,
  markMessageDeleted,
  setChatArchive,
  setChatCustomization,
  setChatPin,
  setChatTheme,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

/** A received (inbound) message, the kind that un-hides a deleted chat. */
function received(guid: string, dateCreated: number) {
  return Message.parse({ guid, text: guid, dateCreated, isFromMe: false });
}

/** A tapback on `target` — a row with a fresh date and NO visible content of its own. */
function reaction(guid: string, dateCreated: number, target: string) {
  return Message.parse({
    guid,
    dateCreated,
    isFromMe: false,
    associatedMessageType: '2000',
    associatedMessageGuid: target,
  });
}

/** A received message that was unsent (retracted) — likewise nothing to render. */
function retracted(guid: string, dateCreated: number) {
  return Message.parse({ guid, text: guid, dateCreated, isFromMe: false, dateRetracted: 9_500 });
}

async function seedChat(
  db: AppDatabase,
  guid: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
  await upsertChats(
    db,
    [Chat.parse({ guid, participants: [{ address: 'a@b.com' }], ...extra })],
    handles,
  );
}

const col = (raw: Database.Database, guid: string, c: string): number | string | null =>
  (raw.prepare(`SELECT ${c} v FROM chats WHERE guid = ?`).get(guid) as { v: number | string })?.v ??
  null;
const counts = (raw: Database.Database, table: string): number =>
  (raw.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;

describe('chat actions repo', () => {
  it('pins and unpins a chat locally', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await setChatPin(db, 'c1', true);
    expect(col(raw, 'c1', 'is_pinned')).toBe(1);
    await setChatPin(db, 'c1', false);
    expect(col(raw, 'c1', 'is_pinned')).toBe(0);
  });

  it('archives a chat locally', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await setChatArchive(db, 'c1', true);
    expect(col(raw, 'c1', 'is_archived')).toBe(1);
  });

  it('keeps a local pin/archive through a server re-sync (server fields still update)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1', { displayName: 'Old' });
    await setChatPin(db, 'c1', true);
    await setChatArchive(db, 'c1', true);

    // Server re-syncs the same chat with pin/archive absent (false) + a new name.
    await seedChat(db, 'c1', { displayName: 'New', isPinned: false, isArchived: false });

    expect(col(raw, 'c1', 'is_pinned')).toBe(1); // local pin survived
    expect(col(raw, 'c1', 'is_archived')).toBe(1); // local archive survived
    expect(col(raw, 'c1', 'display_name')).toBe('New'); // server-authoritative field updated
  });

  it('deleteChatLocal empties the chat and hides it, keeping the row as a tombstone', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const chatId = await getChatIdByGuid(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-x',
      chatId: chatId!,
      chatGuid: 'c1',
      text: 'hi',
      now: 1000,
    });
    expect(counts(raw, 'messages')).toBe(1);
    expect(counts(raw, 'outgoing_queue')).toBe(1);

    await deleteChatLocal(db, 'c1', 5000);

    // The content is gone…
    expect(counts(raw, 'messages')).toBe(0);
    expect(counts(raw, 'outgoing_queue')).toBe(0);
    // …but the ROW survives, carrying the tombstone, so the device-local columns survive with it.
    expect(counts(raw, 'chats')).toBe(1);
    expect(col(raw, 'c1', 'deleted_at')).toBe(5000);
    expect(col(raw, 'c1', 'latest_message_date')).toBeNull();
    // Hidden everywhere a chat is LISTED.
    expect(await listChatsForInbox(db)).toHaveLength(0);
    expect(await listChatsForInbox(db, { includeArchived: true })).toHaveLength(0);
    expect(await findChatByParticipantAddresses(db, ['a@b.com'])).toBeNull();
    // …but NOT from the identity/preferences lookup, which is not a list: a null header reads as
    // "no such chat" to the notification builder, which silently switches the chat's MUTE off.
    expect((await getChatHeader(db, 'c1'))?.guid).toBe('c1');
  });

  it('floors the tombstone at the newest stored message, so a fast Mac clock cannot resurrect it', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const chatId = (await getChatIdByGuid(db, 'c1'))!;
    const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
    // The server's clock is ahead of the phone's: the message the user just read is stamped LATER
    // than the instant they tap Delete.
    await upsertMessages(db, [received('just-read', 9000)], () => chatId, handles);

    await deleteChatLocal(db, 'c1', 5000);

    expect(col(raw, 'c1', 'deleted_at')).toBe(9000);
    // The next sync re-inserts that same message; without the floor it out-dated the tombstone and
    // the conversation came back on every single sync.
    await upsertMessages(db, [received('just-read', 9000)], () => chatId, handles);
    expect(await listChatsForInbox(db)).toHaveLength(0);
  });

  it('a reaction or an unsent message does NOT un-hide a deleted chat (nothing to render)', async () => {
    const { db } = await createTestDb();
    await seedChat(db, 'c1');
    const chatId = (await getChatIdByGuid(db, 'c1'))!;
    const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
    await upsertMessages(db, [received('old', 1000)], () => chatId, handles);

    await deleteChatLocal(db, 'c1', 5000);
    await upsertMessages(db, [received('old', 1000)], () => chatId, handles); // sync re-insert

    // The other party hearts an old message in a thread we deleted — they have no idea we did.
    await upsertMessages(db, [reaction('rx', 9000, 'old')], () => chatId, handles);
    expect(await listChatsForInbox(db)).toHaveLength(0);

    // Same for a message that was sent and then unsent.
    await upsertMessages(db, [retracted('gone', 9100)], () => chatId, handles);
    expect(await listChatsForInbox(db)).toHaveLength(0);

    // Real content still brings it back — with ITS preview, not the pre-deletion one.
    await upsertMessages(db, [received('new', 9200)], () => chatId, handles);
    const rows = await listChatsForInbox(db);
    expect(rows.map((r) => r.lastGuid)).toEqual(['new']);
  });

  it('the un-hide is STICKY — deleting the message that brought a chat back cannot re-hide it', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const chatId = (await getChatIdByGuid(db, 'c1'))!;
    const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);

    await deleteChatLocal(db, 'c1', 5000);
    await upsertMessages(db, [received('new', 6000)], () => chatId, handles);
    expect(await listChatsForInbox(db)).toHaveLength(1);

    // Chat ingestion (any sync page / live event carrying this chat) retires the outlived stamp.
    await seedChat(db, 'c1');
    expect(col(raw, 'c1', 'deleted_at')).toBeNull();

    // The user deletes that one (spam) message. Derived visibility would take the whole
    // conversation with it, even though no chat was deleted.
    await markMessageDeleted(db, 'new', 7000);
    expect((await listChatsForInbox(db)).map((r) => r.guid)).toEqual(['c1']);
  });

  it('re-synced history never retires the tombstone', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const chatId = (await getChatIdByGuid(db, 'c1'))!;
    const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
    await upsertMessages(db, [received('old', 1000)], () => chatId, handles);

    await deleteChatLocal(db, 'c1', 5000);
    await upsertMessages(db, [received('old', 1000)], () => chatId, handles);
    await seedChat(db, 'c1'); // the sync page's chat upsert

    expect(col(raw, 'c1', 'deleted_at')).toBe(5000);
    expect(await listChatsForInbox(db)).toHaveLength(0);
  });

  it('the deletion SURVIVES a re-sync, and so do the local columns the old hard delete destroyed', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1', { displayName: 'Old' });
    await setChatPin(db, 'c1', true);
    await setChatCustomization(db, 'c1', { customName: 'Mum', customColor: '#ff0000' });
    await setChatTheme(db, 'c1', { backgroundUri: 'file:///bg.jpg' });

    await deleteChatLocal(db, 'c1', 5000);
    // The server still has the chat (a local delete never leaves the device), so the next sync
    // page upserts it again — this is what used to resurrect it, stripped of everything local.
    await seedChat(db, 'c1', { displayName: 'New' });

    expect(await listChatsForInbox(db)).toHaveLength(0); // still deleted
    expect(col(raw, 'c1', 'is_pinned')).toBe(1);
    expect(col(raw, 'c1', 'custom_name')).toBe('Mum');
    expect(col(raw, 'c1', 'custom_color')).toBe('#ff0000');
    expect(col(raw, 'c1', 'background_uri')).toBe('file:///bg.jpg');
    expect(col(raw, 'c1', 'display_name')).toBe('New'); // server fields still refresh
  });

  it('a deleted chat comes back on genuinely NEW activity — and only counts what arrived after', async () => {
    const { db } = await createTestDb();
    await seedChat(db, 'c1');
    const chatId = (await getChatIdByGuid(db, 'c1'))!;
    const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
    await upsertMessages(db, [received('old', 1000)], () => chatId, handles);

    await deleteChatLocal(db, 'c1', 5000);
    // Re-synced HISTORY can never un-hide it: every such message predates the tombstone.
    await upsertMessages(db, [received('old', 1000)], () => chatId, handles);
    expect(await listChatsForInbox(db)).toHaveLength(0);

    // A message that actually arrives after the deletion does.
    await upsertMessages(db, [received('new', 6000)], () => chatId, handles);
    const rows = await listChatsForInbox(db);
    expect(rows.map((r) => r.guid)).toEqual(['c1']);
    // The read marker points at a message that went with the delete, so it resolves to 0 — only
    // the post-deletion message may count, never the whole restored history.
    expect(rows[0]!.unreadCount).toBe(1);
    expect(await getChatHeader(db, 'c1')).not.toBeNull();
  });

  it('deleteChatLocal drops the chat-scoped rows that have no foreign key to chats', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await seedChat(db, 'c2');
    await insertScheduled(db, { chatGuid: 'c1', text: 'later', scheduledFor: 9000 });
    await insertScheduled(db, { chatGuid: 'c2', text: 'other', scheduledFor: 9000 });
    // A SERVER-backed row: the Mac fires it, so deleting the row locally would cancel nothing and
    // destroy the only handle the user had. It is `deleteChat`'s job, not this layer's.
    await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'mac fires this',
      scheduledFor: 9000,
      serverId: 'srv-1',
    });
    await createReminder(db, {
      messageGuid: 'm1',
      chatGuid: 'c1',
      messagePreview: 'secret',
      senderName: 'A',
      scheduledFor: 9000,
      notificationId: 'reminder-m1-9000',
    });
    await createReminder(db, {
      messageGuid: 'm2',
      chatGuid: 'c2',
      messagePreview: 'keep',
      senderName: 'B',
      scheduledFor: 9000,
      notificationId: 'reminder-m2-9000',
    });
    await kvSet(db, 'draft.c1', 'half-typed');
    await kvSet(db, 'draft.c2', 'keep me');

    await deleteChatLocal(db, 'c1', 5000);

    // c1's LOCAL-only scheduled row is gone; its server-backed one and c2's are untouched.
    expect(
      (
        raw
          .prepare('SELECT chat_guid g, server_id s FROM scheduled_messages ORDER BY id')
          .all() as {
          g: string;
          s: string | null;
        }[]
      ).map((r) => `${r.g}/${r.s ?? 'local'}`),
    ).toEqual(['c2/local', 'c1/srv-1']);
    // BOTH reminders survive: this layer cannot cancel an OS alarm, and dropping the row makes the
    // alarm unstoppable (nothing else can ever find it). `deleteChat` removes the ones it cancels.
    expect(counts(raw, 'reminders')).toBe(2);
    expect(await kvGet(db, 'draft.c1')).toBeNull();
    // Another chat's reminder and draft are untouched.
    expect(await kvGet(db, 'draft.c2')).toBe('keep me');
    expect(counts(raw, 'chats')).toBe(2);
  });

  // Retiring the tombstone must not silently retire the unread FLOOR with it: `deleted_at` was doing
  // both jobs, so the read marker has to take the floor over as it is cleared.
  it('hands the unread floor to the read marker when it retires the tombstone', async () => {
    const { db } = await createTestDb();
    await seedChat(db, 'c1');
    const chatId = (await getChatIdByGuid(db, 'c1'))!;
    const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
    await upsertMessages(db, [received('old', 1000)], () => chatId, handles);
    await deleteChatLocal(db, 'c1', 5000);
    // History re-syncs (it always does — ensureChatSynced re-pages on every open) and then one new
    // message arrives, which both revives the chat and clears the stamp.
    await upsertMessages(db, [received('old', 1000), received('new', 6000)], () => chatId, handles);

    const rows = await listChatsForInbox(db);
    expect(rows.map((r) => r.guid)).toEqual(['c1']);
    // Still 1, even though deleted_at is gone: only the post-deletion message counts.
    expect(rows[0]!.unreadCount).toBe(1);
  });

  it('clearChatTombstone un-hides a chat (re-composing with the same person reuses the guid)', async () => {
    const { db } = await createTestDb();
    await seedChat(db, 'c1');
    await deleteChatLocal(db, 'c1', 5000);
    expect(await listChatsForInbox(db)).toHaveLength(0);

    await clearChatTombstone(db, 'c1');

    expect((await listChatsForInbox(db)).map((r) => r.guid)).toEqual(['c1']);
  });

  // The floor has to be captured by the DELETE, because the delete is what destroys every message
  // that could carry it. Both un-hide paths below drop `deleted_at` at a point where the boundary
  // message no longer exists, so a handover attempted there matches nothing.
  it('pins the unread floor to the read marker at DELETE time, while the boundary still exists', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const chatId = (await getChatIdByGuid(db, 'c1'))!;
    const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
    await upsertMessages(
      db,
      [received('h1', 1000), received('h2', 2000), received('h3', 3000)],
      () => chatId,
      handles,
    );
    // Never opened — the normal state of the unknown-sender/spam threads people actually delete.
    expect(col(raw, 'c1', 'last_read_message_guid')).toBeNull();

    await deleteChatLocal(db, 'c1', 5000);

    expect(col(raw, 'c1', 'last_read_message_guid')).toBe('h3');
  });

  it('re-composing a deleted thread does not badge its whole restored history', async () => {
    const { db } = await createTestDb();
    await seedChat(db, 'c1');
    const chatId = (await getChatIdByGuid(db, 'c1'))!;
    const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
    const history = [received('h1', 1000), received('h2', 2000), received('h3', 3000)];
    await upsertMessages(db, history, () => chatId, handles);

    await deleteChatLocal(db, 'c1', 5000);
    // A 1:1 guid is derived from the address, so composing to the same person returns the SAME
    // guid and `createNewChat` lifts the tombstone…
    await clearChatTombstone(db, 'c1');
    // …then routing into the thread re-pages its history (ensureChatSynced does this every open).
    await upsertMessages(db, history, () => chatId, handles);

    const rows = await listChatsForInbox(db);
    expect(rows.map((r) => r.guid)).toEqual(['c1']);
    // Without the delete-time handover the marker is still NULL here and this is 3 — the entire
    // conversation the user deleted, badged as unread.
    expect(rows[0]!.unreadCount).toBe(0);
  });

  it('a LIVE un-hide counts only the new message, even when the history backfills later', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const chatId = (await getChatIdByGuid(db, 'c1'))!;
    const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
    const history = [received('h1', 1000), received('h2', 2000), received('h3', 3000)];
    await upsertMessages(db, history, () => chatId, handles);

    await deleteChatLocal(db, 'c1', 5000);
    // The live socket/FCM path stores exactly ONE message — the batch shape that carries both
    // sides of the boundary only ever comes from a 500-message page.
    await upsertMessages(db, [received('new', 6000)], () => chatId, handles);
    expect(col(raw, 'c1', 'deleted_at')).toBeNull();
    // Only afterwards does anything re-page the history.
    await upsertMessages(db, history, () => chatId, handles);

    expect((await listChatsForInbox(db))[0]!.unreadCount).toBe(1);
  });

  // Chat ingestion is a SECOND, independent retire path — a message inserted by anything that does
  // not route through `upsertMessages` leaves the stamp for `upsertChats` to clear.
  it('CHAT ingestion retires an outlived tombstone (sending into a deleted thread)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const chatId = (await getChatIdByGuid(db, 'c1'))!;

    await deleteChatLocal(db, 'c1', 5000);
    // The optimistic send writes the message row directly, so nothing has retired the stamp: the
    // chat is visible only by the read predicate, which is revocable.
    await insertOutgoingText(db, {
      tempGuid: 'temp-x',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 6000,
    });
    expect(col(raw, 'c1', 'deleted_at')).toBe(5000);
    expect(await listChatsForInbox(db)).toHaveLength(1);

    // The next chat ingestion (sync page / live event / persistServerChat) makes it durable.
    await seedChat(db, 'c1');

    expect(col(raw, 'c1', 'deleted_at')).toBeNull();
  });

  it('purges a huge thread in bounded chunks, not one lock-holding statement', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const chatId = (await getChatIdByGuid(db, 'c1'))!;
    // 1201 rows → three purge chunks (500 + 500 + 201). Inserted raw: the point is the DELETE.
    const ins = raw.prepare(
      'INSERT INTO messages (guid, chat_id, text, is_from_me, date_created) VALUES (?,?,?,0,?)',
    );
    raw.transaction(() => {
      for (let i = 0; i < 1201; i++) ins.run(`m${i}`, chatId, 'x', 1000 + i);
    })();

    // Record the statements the driver actually submits, so "one giant DELETE inside the tombstone
    // transaction" cannot come back silently: the whole point is that the write lock is taken and
    // released repeatedly instead of being held for the entire purge.
    const seen: string[] = [];
    const realPrepare = raw.prepare.bind(raw);
    (raw as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => {
      seen.push(s);
      return realPrepare(s);
    };
    try {
      await deleteChatLocal(db, 'c1', 5000);
    } finally {
      (raw as unknown as { prepare: unknown }).prepare = realPrepare;
    }

    expect(counts(raw, 'messages')).toBe(0);
    expect(col(raw, 'c1', 'deleted_at')).toBe(5000);
    // `delete from "scheduled_messages"` deliberately does not match: only a bare `messages`.
    expect(seen.filter((s) => /DELETE\s+FROM\s+messages\b/i.test(s))).toHaveLength(3);
    // …and each chunk is its own short transaction (1 for the tombstone + 3 chunks), so other
    // writers get the process-wide lock in between instead of waiting out the whole purge.
    expect(seen.filter((s) => /^BEGIN/i.test(s.trim()))).toHaveLength(4);
  });

  it('a message that lands DURING the purge survives it', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const chatId = (await getChatIdByGuid(db, 'c1'))!;
    const ins = raw.prepare(
      'INSERT INTO messages (guid, chat_id, text, is_from_me, date_created) VALUES (?,?,?,0,?)',
    );
    raw.transaction(() => {
      for (let i = 0; i < 700; i++) ins.run(`m${i}`, chatId, 'x', 1000 + i);
    })();

    // Yielding the write lock between chunks is the point of chunking, so a live socket/FCM
    // message really can arrive mid-purge. Simulated by landing one as the first chunk closes.
    let deletes = 0;
    let landed = false;
    const realPrepare = raw.prepare.bind(raw);
    (raw as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => {
      if (/DELETE\s+FROM\s+messages\b/i.test(s)) deletes++;
      if (deletes === 1 && !landed && /^COMMIT/i.test(s.trim())) {
        landed = true;
        ins.run('live', chatId, 'still here?', 9000);
      }
      return realPrepare(s);
    };
    try {
      await deleteChatLocal(db, 'c1', 5000);
    } finally {
      (raw as unknown as { prepare: unknown }).prepare = realPrepare;
    }

    expect(landed).toBe(true);
    // An unbounded `WHERE chat_id = ?` would take it with the backlog — losing a message nobody was
    // told about, in a chat its own arrival has just made visible again.
    expect(
      raw
        .prepare('SELECT guid FROM messages')
        .all()
        .map((r) => (r as { guid: string }).guid),
    ).toEqual(['live']);
    expect((await listChatsForInbox(db)).map((r) => r.guid)).toEqual(['c1']);
  });

  it('deleteChatLocal is a no-op for an unknown guid', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await deleteChatLocal(db, 'nope', 5000);
    expect(counts(raw, 'chats')).toBe(1);
    expect(col(raw, 'c1', 'deleted_at')).toBeNull();
  });
});
