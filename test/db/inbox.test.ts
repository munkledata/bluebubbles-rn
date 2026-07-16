import { Chat, Message } from '@core/models';
import {
  applyLocalUnsend,
  listChatsForInbox,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { createTestDb } from '../support/testDb';

type Db = Awaited<ReturnType<typeof createTestDb>>;

async function seedChat(
  t: Db,
  guid: string,
  opts: {
    participants: string[];
    displayName?: string;
    style?: number;
    pinned?: boolean;
    messages: { guid: string; text: string; date: number; fromMe?: boolean; rowId?: number }[];
    readGuid?: string | null;
    archived?: boolean;
  },
) {
  const handles = await upsertHandles(
    t.db,
    opts.participants.map((address) => ({ address })),
  );
  const map = await upsertChats(
    t.db,
    [
      Chat.parse({
        guid,
        displayName: opts.displayName ?? null,
        style: opts.style ?? (opts.participants.length > 1 ? 45 : 43),
        isPinned: opts.pinned ?? false,
        isArchived: opts.archived ?? false,
        participants: opts.participants.map((address) => ({ address })),
      }),
    ],
    handles,
  );
  const chatId = map.get(guid)!;
  await upsertMessages(
    t.db,
    opts.messages.map((m) =>
      Message.parse({
        guid: m.guid,
        text: m.text,
        isFromMe: m.fromMe ?? false,
        dateCreated: m.date,
        originalROWID: m.rowId ?? m.date,
        handle: m.fromMe ? null : { address: opts.participants[0]! },
      }),
    ),
    () => chatId,
    handles,
  );
  if (opts.readGuid !== undefined) {
    t.raw
      .prepare('UPDATE chats SET last_read_message_guid = ? WHERE guid = ?')
      .run(opts.readGuid, guid);
  }
  return chatId;
}

describe('listChatsForInbox', () => {
  it('orders pinned chats first, then by latest message desc', async () => {
    const t = await createTestDb();
    await seedChat(t, 'old', {
      participants: ['a@x.com'],
      messages: [{ guid: 'o1', text: 'old', date: 100 }],
    });
    await seedChat(t, 'newest', {
      participants: ['b@x.com'],
      messages: [{ guid: 'n1', text: 'new', date: 9000 }],
    });
    await seedChat(t, 'pinnedOld', {
      participants: ['c@x.com'],
      pinned: true,
      messages: [{ guid: 'p1', text: 'pin', date: 50 }],
    });

    const rows = await listChatsForInbox(t.db);
    // pinned first (even though oldest), then unpinned newest→oldest
    expect(rows.map((r) => r.guid)).toEqual(['pinnedOld', 'newest', 'old']);
  });

  it('exposes the newest message as the preview fields', async () => {
    const t = await createTestDb();
    await seedChat(t, 'c1', {
      participants: ['a@x.com'],
      messages: [
        { guid: 'm1', text: 'first', date: 100 },
        { guid: 'm2', text: 'latest', date: 200, fromMe: true },
      ],
    });
    const [row] = await listChatsForInbox(t.db);
    expect(row!.lastText).toBe('latest');
    expect(row!.lastIsFromMe).toBe(1);
    expect(row!.lastDate).toBe(200);
  });

  it('computes unread from last-read marker; outbound never counts', async () => {
    const t = await createTestDb();
    // read up to the newest → unread 0
    await seedChat(t, 'read', {
      participants: ['a@x.com'],
      readGuid: 'r2',
      messages: [
        { guid: 'r1', text: 'a', date: 100 },
        { guid: 'r2', text: 'b', date: 200 },
      ],
    });
    // read only the older → 1 unread
    await seedChat(t, 'partial', {
      participants: ['b@x.com'],
      readGuid: 'p1',
      messages: [
        { guid: 'p1', text: 'a', date: 100 },
        { guid: 'p2', text: 'b', date: 200 },
      ],
    });
    // never read, 2 inbound → 2 unread
    await seedChat(t, 'fresh', {
      participants: ['c@x.com'],
      readGuid: null,
      messages: [
        { guid: 'f1', text: 'a', date: 100 },
        { guid: 'f2', text: 'b', date: 200 },
      ],
    });
    // outbound only → 0 unread
    await seedChat(t, 'mine', {
      participants: ['d@x.com'],
      readGuid: null,
      messages: [{ guid: 'o1', text: 'hey', date: 100, fromMe: true }],
    });

    const byGuid = Object.fromEntries(
      (await listChatsForInbox(t.db)).map((r) => [r.guid, r.unreadCount]),
    );
    expect(byGuid.read).toBe(0);
    expect(byGuid.partial).toBe(1);
    expect(byGuid.fresh).toBe(2);
    expect(byGuid.mine).toBe(0);
  });

  it('excludes a retracted (unsent) inbound message from the unread count', async () => {
    // The badge must agree with the in-chat unread chip (getFirstUnreadInChat), which drops
    // retracted rows — otherwise a sender unsending a message leaves a phantom unread on the tile.
    const t = await createTestDb();
    await seedChat(t, 'c', {
      participants: ['a@x.com'],
      readGuid: null,
      messages: [
        { guid: 'u1', text: 'a', date: 100 },
        { guid: 'u2', text: 'b', date: 200 },
      ],
    });
    const before = await listChatsForInbox(t.db);
    expect(before[0]!.unreadCount).toBe(2);

    await applyLocalUnsend(t.db, 'u2', 9000);
    const after = await listChatsForInbox(t.db);
    expect(after[0]!.unreadCount).toBe(1);
  });

  it('reports participant count/names and toggles archived', async () => {
    const t = await createTestDb();
    await seedChat(t, 'dm', {
      participants: ['solo@x.com'],
      messages: [{ guid: 'd1', text: 'hi', date: 100 }],
    });
    await seedChat(t, 'grp', {
      participants: ['a@x.com', 'b@x.com', 'c@x.com'],
      displayName: 'Trio',
      messages: [{ guid: 'g1', text: 'yo', date: 200 }],
    });
    await seedChat(t, 'arch', {
      participants: ['z@x.com'],
      archived: true,
      messages: [{ guid: 'a1', text: 'old', date: 300 }],
    });

    const visible = await listChatsForInbox(t.db);
    expect(visible.map((r) => r.guid).sort()).toEqual(['dm', 'grp']); // archived hidden
    const grp = visible.find((r) => r.guid === 'grp')!;
    expect(grp.participantCount).toBe(3);
    expect(grp.participantNames?.split(', ')).toHaveLength(3);

    const all = await listChatsForInbox(t.db, { includeArchived: true });
    expect(all.map((r) => r.guid)).toContain('arch');
  });
});
