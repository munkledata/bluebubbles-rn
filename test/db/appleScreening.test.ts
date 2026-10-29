import { sql } from 'drizzle-orm';
import { Chat, Message } from '@core/models';
import {
  appleScreeningEmitted,
  setAppleScreeningCapabilityReader,
} from '@db/appleScreeningCapability';
import {
  chatHasKnownSender,
  countChatsForInbox,
  listChatsForInboxPage,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

let capability = false;

beforeEach(() => {
  capability = false;
  setAppleScreeningCapabilityReader(() => capability);
});

afterAll(() => {
  setAppleScreeningCapabilityReader(() => false);
});

async function chatFlag(db: AppDatabase, guid: string): Promise<number | null> {
  const rows = await db.all<{ flag: number | null }>(
    sql`SELECT apple_filtered AS flag FROM chats WHERE guid = ${guid}`,
  );
  return rows[0]?.flag ?? null;
}

async function messageFlag(db: AppDatabase, guid: string): Promise<number | null> {
  const rows = await db.all<{ flag: number | null }>(
    sql`SELECT apple_spam AS flag FROM messages WHERE guid = ${guid}`,
  );
  return rows[0]?.flag ?? null;
}

describe('Apple screening capability gate', () => {
  it('is off until a reader says otherwise, and a throwing reader reads as off', () => {
    setAppleScreeningCapabilityReader(() => true);
    expect(appleScreeningEmitted()).toBe(true);
    setAppleScreeningCapabilityReader(() => {
      throw new Error('no server info');
    });
    expect(appleScreeningEmitted()).toBe(false);
  });
});

describe('Apple screening ingestion', () => {
  it('stores the chat flag only while the capability is on, and keeps it when the key is absent', async () => {
    const { db } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'a@example.com' }]);
    const participants = [{ address: 'a@example.com' }];

    // Capability missing: even an explicit flag is not trusted, and the column stays unknown.
    await upsertChats(db, [Chat.parse({ guid: 'c1', participants, isFiltered: true })], handles);
    expect(await chatFlag(db, 'c1')).toBeNull();

    capability = true;
    await upsertChats(db, [Chat.parse({ guid: 'c1', participants, isFiltered: true })], handles);
    expect(await chatFlag(db, 'c1')).toBe(1);

    // Capability on but the key omitted (older chat.db): keep what is stored.
    await upsertChats(db, [Chat.parse({ guid: 'c1', participants })], handles);
    expect(await chatFlag(db, 'c1')).toBe(1);

    // Capability missing again (server setting turned off): an absent key is not "not filtered".
    capability = false;
    await upsertChats(db, [Chat.parse({ guid: 'c1', participants })], handles);
    expect(await chatFlag(db, 'c1')).toBe(1);
    await upsertChats(db, [Chat.parse({ guid: 'c1', participants, isFiltered: false })], handles);
    expect(await chatFlag(db, 'c1')).toBe(1);

    // A capable server can clear it.
    capability = true;
    await upsertChats(db, [Chat.parse({ guid: 'c1', participants, isFiltered: false })], handles);
    expect(await chatFlag(db, 'c1')).toBe(0);
  });

  it('stores the message spam flag only while the capability is on, and keeps it when absent', async () => {
    const { db } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'a@example.com' }]);
    const chats = await upsertChats(
      db,
      [Chat.parse({ guid: 'c1', participants: [{ address: 'a@example.com' }] })],
      handles,
    );
    const chatId = chats.get('c1')!;
    const write = (fields: Record<string, unknown>) =>
      upsertMessages(
        db,
        [Message.parse({ guid: 'm1', dateCreated: 100, isFromMe: false, ...fields })],
        () => chatId,
        new Map(),
      );

    await write({ isSpam: true });
    expect(await messageFlag(db, 'm1')).toBeNull();

    capability = true;
    await write({ isSpam: true });
    expect(await messageFlag(db, 'm1')).toBe(1);
    await write({});
    expect(await messageFlag(db, 'm1')).toBe(1);

    capability = false;
    await write({ isSpam: false });
    expect(await messageFlag(db, 'm1')).toBe(1);

    capability = true;
    await write({ isSpam: false });
    expect(await messageFlag(db, 'm1')).toBe(0);
  });

  it('reads the flag from a chat embedded in a message payload', async () => {
    const { db } = await createTestDb();
    capability = true;
    const message = Message.parse({ guid: 'm1', chats: [{ guid: 'c1', isFiltered: true }] });
    await upsertChats(db, message.chats ?? [], new Map());
    expect(await chatFlag(db, 'c1')).toBe(1);
  });
});

describe('Apple screening in the Unknown Senders split', () => {
  async function seed(): Promise<AppDatabase> {
    const { db } = await createTestDb();
    capability = true;
    const handles = await upsertHandles(db, [
      { address: 'friend@example.com' },
      { address: 'spam-contact@example.com' },
      { address: 'stranger@example.com' },
      { address: 'outgoing@example.com' },
    ]);
    const chats = await upsertChats(
      db,
      [
        Chat.parse({ guid: 'c-plain', participants: [{ address: 'friend@example.com' }] }),
        Chat.parse({
          guid: 'c-filtered',
          participants: [{ address: 'friend@example.com' }],
          isFiltered: true,
        }),
        Chat.parse({ guid: 'c-spam', participants: [{ address: 'spam-contact@example.com' }] }),
        Chat.parse({ guid: 'c-stranger', participants: [{ address: 'stranger@example.com' }] }),
        Chat.parse({ guid: 'c-outgoing', participants: [{ address: 'outgoing@example.com' }] }),
      ],
      handles,
    );
    await db.run(sql`UPDATE handles SET contact_id = 1 WHERE address <> 'stranger@example.com'`);
    const ids = new Map([...chats]);
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'm-plain',
          dateCreated: 10,
          text: 'x',
          chats: [{ guid: 'c-plain' }],
        }),
        Message.parse({
          guid: 'm-filtered',
          dateCreated: 20,
          text: 'x',
          chats: [{ guid: 'c-filtered' }],
        }),
        Message.parse({
          guid: 'm-spam',
          dateCreated: 30,
          text: 'x',
          isSpam: true,
          chats: [{ guid: 'c-spam' }],
        }),
        Message.parse({
          guid: 'm-stranger',
          dateCreated: 40,
          text: 'x',
          chats: [{ guid: 'c-stranger' }],
        }),
        // Our own message flagged as spam does not screen the chat.
        Message.parse({
          guid: 'm-outgoing',
          dateCreated: 50,
          text: 'x',
          isFromMe: true,
          isSpam: true,
          chats: [{ guid: 'c-outgoing' }],
        }),
      ],
      (m) => ids.get(m.chats?.[0]?.guid ?? ''),
      new Map(),
    );
    return db;
  }

  const guids = (rows: { guid: string }[]) => rows.map((row) => row.guid).sort();

  it('setting OFF: Apple flags change nothing (contacts alone decide)', async () => {
    const db = await seed();
    const known = await listChatsForInboxPage(db, { sender: 'known', limit: 50 });
    expect(guids(known.rows)).toEqual(['c-filtered', 'c-outgoing', 'c-plain', 'c-spam']);
    const unknown = await listChatsForInboxPage(db, { sender: 'unknown', limit: 50 });
    expect(guids(unknown.rows)).toEqual(['c-stranger']);
    expect(await countChatsForInbox(db, { sender: 'unknown' })).toBe(1);
    const all = await listChatsForInboxPage(db, { limit: 50 });
    expect(all.rows.find((row) => row.guid === 'c-filtered')?.hasKnownSender).toBe(1);
  });

  it('setting ON: filtered and spam chats move to Unknown Senders even with a contact', async () => {
    const db = await seed();
    const known = await listChatsForInboxPage(db, {
      sender: 'known',
      limit: 50,
      appleScreening: true,
    });
    expect(guids(known.rows)).toEqual(['c-outgoing', 'c-plain']);
    const unknown = await listChatsForInboxPage(db, {
      sender: 'unknown',
      limit: 50,
      appleScreening: true,
    });
    expect(guids(unknown.rows)).toEqual(['c-filtered', 'c-spam', 'c-stranger']);
    // The route's fail-closed row check (hasKnownSender !== 1) keeps them.
    expect(unknown.rows.every((row) => row.hasKnownSender !== 1)).toBe(true);
    expect(await countChatsForInbox(db, { sender: 'unknown', appleScreening: true })).toBe(3);

    // The notification check silences the same chats.
    expect(await chatHasKnownSender(db, 'c-plain')).toBe(true);
    expect(await chatHasKnownSender(db, 'c-outgoing')).toBe(true);
    expect(await chatHasKnownSender(db, 'c-filtered')).toBe(false);
    expect(await chatHasKnownSender(db, 'c-spam')).toBe(false);
    expect(await chatHasKnownSender(db, 'c-stranger')).toBe(false);
  });

  it('a locally deleted spam message no longer screens its chat', async () => {
    const db = await seed();
    await db.run(sql`UPDATE messages SET date_deleted = 99 WHERE guid = 'm-spam'`);
    expect(await chatHasKnownSender(db, 'c-spam')).toBe(true);
  });

  it('a reply from the user makes a screened chat known again', async () => {
    const db = await seed();
    const chatRows = await db.all<{ guid: string; id: number }>(
      sql`SELECT guid, id FROM chats WHERE guid IN ('c-filtered', 'c-spam')`,
    );
    const ids = new Map<string, number>(
      chatRows.map((row: { guid: string; id: number }) => [row.guid, row.id]),
    );
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'm-reply-spam',
          dateCreated: 60,
          text: 'x',
          isFromMe: true,
          chats: [{ guid: 'c-spam' }],
        }),
        Message.parse({
          guid: 'm-reply-filtered',
          dateCreated: 61,
          text: 'x',
          isFromMe: true,
          chats: [{ guid: 'c-filtered' }],
        }),
      ],
      (m) => ids.get(m.chats?.[0]?.guid ?? ''),
      new Map(),
    );
    expect(await chatHasKnownSender(db, 'c-spam')).toBe(true);
    expect(await chatHasKnownSender(db, 'c-filtered')).toBe(true);
    const unknown = await listChatsForInboxPage(db, {
      sender: 'unknown',
      limit: 50,
      appleScreening: true,
    });
    expect(guids(unknown.rows)).toEqual(['c-stranger']);

    // A reply the user deleted locally doesn't count.
    await db.run(sql`UPDATE messages SET date_deleted = 99 WHERE guid = 'm-reply-spam'`);
    expect(await chatHasKnownSender(db, 'c-spam')).toBe(false);
  });

  it('capability missing: nothing is screened even with the setting ON', async () => {
    const { db } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'friend@example.com' }]);
    await upsertChats(
      db,
      [
        Chat.parse({
          guid: 'c-filtered',
          participants: [{ address: 'friend@example.com' }],
          isFiltered: true,
        }),
      ],
      handles,
    );
    await db.run(sql`UPDATE handles SET contact_id = 1`);
    const known = await listChatsForInboxPage(db, {
      sender: 'known',
      limit: 50,
      appleScreening: true,
    });
    expect(guids(known.rows)).toEqual(['c-filtered']);
    expect(await chatHasKnownSender(db, 'c-filtered')).toBe(true);
  });
});
