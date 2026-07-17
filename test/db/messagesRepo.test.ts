import { Chat, Message } from '@core/models';
import {
  applyLocalUnsend,
  getChatHeader,
  listThreadMessages,
  getChatIdByGuid,
  getFirstUnreadInChat,
  getNewestReceivedGuid,
  listChatsForInbox,
  listMessagesAround,
  listMessagesWithSenders,
  markMessageDeleted,
  setLastReadMessageGuid,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { buildGroupEventText } from '@utils';
import { createTestDb } from '../support/testDb';

async function seed(db: AppDatabase) {
  const handles = await upsertHandles(db, [
    { address: 'a@x.com', displayName: 'Alice' },
    { address: 'b@x.com', displayName: 'Bob' },
  ]);
  const map = await upsertChats(
    db,
    [
      Chat.parse({
        guid: 'c1',
        displayName: 'Group',
        participants: [{ address: 'a@x.com' }, { address: 'b@x.com' }],
      }),
    ],
    handles,
  );
  const chatId = map.get('c1')!;
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: 'm1',
        text: 'first',
        dateCreated: 100,
        handle: { address: 'a@x.com' },
      }),
      Message.parse({ guid: 'm2', text: 'mine', isFromMe: true, dateCreated: 200 }),
      Message.parse({
        guid: 'm3',
        text: 'latest',
        dateCreated: 300,
        handle: { address: 'b@x.com' },
      }),
    ],
    () => chatId,
    handles,
  );
  return chatId;
}

describe('conversation-view repositories', () => {
  it('getChatIdByGuid resolves hit/miss', async () => {
    const { db } = await createTestDb();
    const id = await seed(db);
    expect(await getChatIdByGuid(db, 'c1')).toBe(id);
    expect(await getChatIdByGuid(db, 'nope')).toBeNull();
  });

  it('listMessagesWithSenders returns newest-first with sender names', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    const rows = await listMessagesWithSenders(db, chatId);
    expect(rows.map((r) => r.guid)).toEqual(['m3', 'm2', 'm1']); // newest first
    expect(rows[0]!.senderName).toBe('Bob');
    expect(rows[1]!.isFromMe).toBe(1);
    expect(rows[2]!.senderName).toBe('Alice');
  });

  it('listThreadMessages returns the originator + all its replies chronologically', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db); // m1 recv@100, m2 mine@200, m3 recv@300
    const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'r1',
          text: 'first reply',
          dateCreated: 400,
          threadOriginatorGuid: 'm1',
          handle: { address: 'a@x.com' },
        }),
        Message.parse({
          guid: 'r2',
          text: 'second reply',
          isFromMe: true,
          dateCreated: 500,
          threadOriginatorGuid: 'm1',
        }),
      ],
      () => chatId,
      handles,
    );
    const thread = await listThreadMessages(db, 'm1');
    expect(thread.map((m) => m.guid)).toEqual(['m1', 'r1', 'r2']); // originator first, then replies
    // Unrelated messages (m2/m3) are excluded.
    expect(thread.some((m) => m.guid === 'm3')).toBe(false);
  });

  it('getFirstUnreadInChat finds the oldest RECEIVED message past the read marker + count', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db); // m1 recv@100, m2 mine@200, m3 recv@300
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'm4',
          text: 'newest',
          dateCreated: 400,
          handle: { address: 'a@x.com' },
        }),
      ],
      () => chatId,
      await upsertHandles(db, [{ address: 'a@x.com' }]),
    );

    // Marker at m1 → the first unread is m3 (m2 is OWN, never unread); count = m3 + m4.
    await setLastReadMessageGuid(db, 'c1', 'm1');
    const fu = await getFirstUnreadInChat(db, chatId);
    expect(fu).toMatchObject({ guid: 'm3', dateCreated: 300, count: 2 });

    // Never-read chat → everything received is unread, starting at m1.
    await setLastReadMessageGuid(db, 'c1', '');
    const never = await getFirstUnreadInChat(db, chatId);
    expect(never).toMatchObject({ guid: 'm1', count: 3 });

    // Fully read → null.
    await setLastReadMessageGuid(db, 'c1', 'm4');
    expect(await getFirstUnreadInChat(db, chatId)).toBeNull();
  });

  it('persists group-event columns and resolves other_handle → participant name', async () => {
    const { db } = await createTestDb();
    const handles = await upsertHandles(db, [
      { address: 'a@x.com', displayName: 'Alice' },
      { address: 'b@x.com', displayName: 'Bob', originalROWID: 42 },
    ]);
    const map = await upsertChats(
      db,
      [
        Chat.parse({
          guid: 'c1',
          displayName: 'Group',
          participants: [{ address: 'a@x.com' }, { address: 'b@x.com' }],
        }),
      ],
      handles,
    );
    const chatId = map.get('c1')!;
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'ge1',
          text: '',
          dateCreated: 500,
          handle: { address: 'a@x.com' },
          itemType: 1, // participant add/remove
          groupActionType: 0, // add
          otherHandle: 42, // Bob's server ROWID
        }),
      ],
      () => chatId,
      handles,
    );
    const row = (await listMessagesWithSenders(db, chatId)).find((r) => r.guid === 'ge1')!;
    expect(row.itemType).toBe(1);
    expect(row.groupActionType).toBe(0);
    expect(row.otherHandleName).toBe('Bob'); // resolved from other_handle via original_row_id
    expect(row.senderName).toBe('Alice');
    expect(buildGroupEventText(row)).toBe('Alice added Bob to the conversation.');
  });

  it('repairs a null sender on a later hydrated re-sync, and never wipes a good one', async () => {
    const { db } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'a@x.com', displayName: 'Alice' }]);
    const map = await upsertChats(db, [Chat.parse({ guid: 'c1', displayName: 'Group' })], handles);
    const chatId = map.get('c1')!;

    // 1) Handle-less fetch (the old chat-open backfill): message inserted with NO sender.
    await upsertMessages(
      db,
      [Message.parse({ guid: 'mX', text: 'hi', dateCreated: 100 })],
      () => chatId,
      handles,
    );
    let row = (await listMessagesWithSenders(db, chatId)).find((r) => r.guid === 'mX')!;
    expect(row.senderAddress).toBeNull(); // renders as "?"

    // 2) A later hydrated re-sync carries the sender → COALESCE fills the null handle.
    await upsertMessages(
      db,
      [Message.parse({ guid: 'mX', text: 'hi', dateCreated: 100, handle: { address: 'a@x.com' } })],
      () => chatId,
      handles,
    );
    row = (await listMessagesWithSenders(db, chatId)).find((r) => r.guid === 'mX')!;
    expect(row.senderAddress).toBe('a@x.com');
    expect(row.senderName).toBe('Alice');

    // 3) A subsequent handle-less fetch must NOT wipe the resolved sender.
    await upsertMessages(
      db,
      [Message.parse({ guid: 'mX', text: 'hi edited', dateCreated: 100 })],
      () => chatId,
      handles,
    );
    row = (await listMessagesWithSenders(db, chatId)).find((r) => r.guid === 'mX')!;
    expect(row.senderAddress).toBe('a@x.com');
  });

  it('paginates with beforeDate', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    const older = await listMessagesWithSenders(db, chatId, 100, 300); // strictly older than m3
    expect(older.map((r) => r.guid)).toEqual(['m2', 'm1']);
  });

  it('listMessagesAround centers on the anchor with context on both sides', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    // Anchor on the middle message (m2 @ 200): both the newer (m3) and older (m1) appear.
    const rows = await listMessagesAround(db, chatId, 200);
    expect(rows.map((r) => r.guid)).toEqual(['m3', 'm2', 'm1']); // newest-first, anchor centered
  });

  it('listMessagesAround on the NEWEST message still loads older context (the bug repro)', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    // Old bug: jumping to a hit that's the newest message showed just that one message. The
    // window must still pull the older ones below it.
    const rows = await listMessagesAround(db, chatId, 300);
    expect(rows.map((r) => r.guid)).toEqual(['m3', 'm2', 'm1']);
  });

  it('listMessagesAround respects the before/after window caps', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    // Anchor m1 (@100) with before=0, after=1 → only the anchor + one newer (m3 excluded).
    const rows = await listMessagesAround(db, chatId, 100, 0, 1);
    expect(rows.map((r) => r.guid)).toEqual(['m2', 'm1']);
  });

  it('getNewestReceivedGuid ignores outgoing', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    expect(await getNewestReceivedGuid(db, chatId)).toBe('m3'); // not m2 (mine)
  });

  it('getChatHeader returns title + participant info', async () => {
    const { db } = await createTestDb();
    await seed(db);
    const h = await getChatHeader(db, 'c1');
    expect(h?.displayName).toBe('Group');
    expect(h?.participantCount).toBe(2);
  });

  it('setLastReadMessageGuid clears the inbox unread count', async () => {
    const { db } = await createTestDb();
    await seed(db);
    let inbox = await listChatsForInbox(db);
    expect(inbox[0]!.unreadCount).toBeGreaterThan(0);
    await setLastReadMessageGuid(db, 'c1', 'm3');
    inbox = await listChatsForInbox(db);
    expect(inbox[0]!.unreadCount).toBe(0);
  });

  // Fix #8: a later event that OMITS a delivery-tier flag must not downgrade a stored
  // `true` (COALESCE(excluded.x, messages.x) on conflict). A later event that DOES carry
  // the flag still updates it.
  it('upsertMessages does not let a flagless re-upsert downgrade a stored delivery tier', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db);
    const tier = (guid: string): { q: number | null; n: number | null } =>
      raw
        .prepare(
          'SELECT was_delivered_quietly q, did_notify_recipient n FROM messages WHERE guid = ?',
        )
        .get(guid) as { q: number | null; n: number | null };

    // First event sets the quiet-delivery tier true.
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'q1',
          text: 'quiet',
          dateCreated: 400,
          handle: { address: 'a@x.com' },
          wasDeliveredQuietly: true,
          didNotifyRecipient: true,
        }),
      ],
      () => chatId,
      new Map(),
    );
    expect(tier('q1').q).toBe(1);
    expect(tier('q1').n).toBe(1);

    // A later event for the same guid OMITS both flags → the stored trues must survive.
    await upsertMessages(
      db,
      [Message.parse({ guid: 'q1', text: 'quiet edited', dateCreated: 400 })],
      () => chatId,
      new Map(),
    );
    expect(tier('q1').q).toBe(1); // not downgraded
    expect(tier('q1').n).toBe(1);

    // A later event that DOES carry a (different) flag still updates it.
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'q1',
          dateCreated: 400,
          wasDeliveredQuietly: true,
          didNotifyRecipient: false,
        }),
      ],
      () => chatId,
      new Map(),
    );
    expect(tier('q1').q).toBe(1);
    expect(tier('q1').n).toBe(0); // explicit false IS applied
  });

  // Apple "Send Later": the server emits isScheduled=true only while a row is PENDING and omits it
  // once it sends. Persist it (so a synced pending row can be badged), and — unlike the delivery
  // tiers — PLAIN-overwrite on conflict so the flagless "sent" re-upsert clears the badge.
  it('persists isScheduled and clears it (plain overwrite) when a later event omits it (sent)', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db);
    const sched = (guid: string): number | null =>
      (
        raw.prepare('SELECT is_scheduled FROM messages WHERE guid = ?').get(guid) as {
          is_scheduled: number | null;
        }
      ).is_scheduled;

    // A pending Send-Later row (server sends isScheduled: true) → stored as 1 and read back.
    await upsertMessages(
      db,
      [Message.parse({ guid: 'sch1', text: 'later', isFromMe: true, dateCreated: 4_000, isScheduled: true })],
      () => chatId,
      new Map(),
    );
    expect(sched('sch1')).toBe(1);
    const row = (await listMessagesWithSenders(db, chatId)).find((r) => r.guid === 'sch1')!;
    expect(row.isScheduled).toBe(1);

    // The message SENDS: the server stops emitting isScheduled (presence-driven), so the flagless
    // re-upsert plain-overwrites is_scheduled to NULL — clearing the "Scheduled" badge.
    await upsertMessages(
      db,
      [Message.parse({ guid: 'sch1', text: 'later', isFromMe: true, dateCreated: 4_000 })],
      () => chatId,
      new Map(),
    );
    expect(sched('sch1')).toBeNull();

    // A never-scheduled message stores NULL (never badged).
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'sch2',
          text: 'normal',
          dateCreated: 5_000,
          handle: { address: 'a@x.com' },
        }),
      ],
      () => chatId,
      new Map(),
    );
    expect(sched('sch2')).toBeNull();
  });
});

describe('markMessageDeleted (deletion tombstone)', () => {
  it('tombstones the newest message, recomputes latest_message_date to the survivor, and hides it', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db); // m1 recv@100, m2 mine@200, m3 recv@300 (newest)
    const latestDate = (): number | null =>
      (
        raw.prepare('SELECT latest_message_date d FROM chats WHERE id = ?').get(chatId) as {
          d: number | null;
        }
      ).d;
    expect(latestDate()).toBe(300); // m3 is the newest

    const found = await markMessageDeleted(db, 'm3', 5000);
    expect(found).toBe(true);

    // The tombstone is written (Unix ms) — the row still exists (NOT hard-deleted) …
    const del = (
      raw.prepare('SELECT date_deleted d FROM messages WHERE guid = ?').get('m3') as {
        d: number | null;
      }
    ).d;
    expect(del).toBe(5000);
    // … but VANISHES from the rendered thread (the deleted-newest falls back to m2) …
    expect((await listMessagesWithSenders(db, chatId)).map((r) => r.guid)).toEqual(['m2', 'm1']);
    // … and the denormalized inbox sort key falls to the previous surviving message (m2 @200).
    expect(latestDate()).toBe(200);
  });

  it('excludes the deleted originator/reply from listThreadMessages too', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'r1',
          text: 'a reply',
          dateCreated: 400,
          threadOriginatorGuid: 'm1',
          handle: { address: 'a@x.com' },
        }),
      ],
      () => chatId,
      handles,
    );
    expect((await listThreadMessages(db, 'm1')).map((m) => m.guid)).toEqual(['m1', 'r1']);
    await markMessageDeleted(db, 'r1', 5000);
    expect((await listThreadMessages(db, 'm1')).map((m) => m.guid)).toEqual(['m1']); // reply gone
  });

  it('recompute COUNTS retracted rows (they still render as tombstones) but excludes deleted ones', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db); // m1@100, m2@200, m3@300
    const latestDate = (): number | null =>
      (
        raw.prepare('SELECT latest_message_date d FROM chats WHERE id = ?').get(chatId) as {
          d: number | null;
        }
      ).d;
    // Unsend the NEWEST (m3): a retracted row still renders as a tombstone bubble, so it must keep
    // holding the chat's latest position.
    await applyLocalUnsend(db, 'm3', 4000);
    // Now delete a MIDDLE message (m2). Survivors: m1@100 and the retracted m3@300 → MAX must be 300.
    const found = await markMessageDeleted(db, 'm2', 5000);
    expect(found).toBe(true);
    expect(latestDate()).toBe(300); // retracted m3 counts; only the deleted m2 is excluded
  });

  it('is a safe no-op for an unknown guid (returns false, changes nothing)', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db);
    const latestDate = (): number | null =>
      (
        raw.prepare('SELECT latest_message_date d FROM chats WHERE id = ?').get(chatId) as {
          d: number | null;
        }
      ).d;
    const before = latestDate();
    expect(await markMessageDeleted(db, 'does-not-exist', 5000)).toBe(false);
    expect(latestDate()).toBe(before); // untouched
    // No stray tombstone landed on any real row.
    const anyDeleted = raw
      .prepare('SELECT COUNT(*) c FROM messages WHERE date_deleted IS NOT NULL')
      .get() as { c: number };
    expect(anyDeleted.c).toBe(0);
  });
});
