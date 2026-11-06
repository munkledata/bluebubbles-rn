import type Database from 'better-sqlite3';
import { Chat, Message } from '@core/models';
import {
  chatHasKnownSender,
  countChatsForInbox,
  findChatsByParticipantAddresses,
  getChatIdByGuid,
  getChatParticipantContacts,
  listChatsForInboxPage,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { TestDb } from '@db/types';
import { createTestDb } from '../support/testDb';
import { setChatArchive, setChatPin } from '../support/repositoryWrappers';

/**
 * Inbox paging at its boundaries (fix plan I-1): equal latest-message timestamps, the hasMore edge,
 * pins and archive against ties, the count's agreement with the page, the participant-address
 * matcher's exact-set rule, and the participant-contact lookup.
 */

const T = 1_800_000_000_000;
const ALICE = 'alice@x.com';
const BOB = 'bob@x.com';
const CAROL = '+15550001111';

/** Seven DM chats whose newest message carries the SAME timestamp; chat ids ascend c1 → c7. */
async function seedTiedChats(db: TestDb): Promise<string[]> {
  const handles = await upsertHandles(db, [{ address: ALICE, service: 'iMessage' }]);
  const guids = Array.from({ length: 7 }, (_, index) => `iMessage;-;tie-${index + 1}`);
  const chatMap = await upsertChats(
    db,
    guids.map((guid) =>
      Chat.parse({ guid, style: 45, participants: [{ address: ALICE, service: 'iMessage' }] }),
    ),
    handles,
  );
  for (const guid of guids) {
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: `m-${guid}`,
          text: 'same time',
          dateCreated: T,
          handle: { address: ALICE },
        }),
      ],
      () => chatMap.get(guid)!,
      handles,
    );
  }
  return guids;
}

const rowGuids = (rows: Array<{ guid: string }>): string[] => rows.map((row) => row.guid);

describe('listChatsForInboxPage with tied timestamps', () => {
  it('breaks ties by chat id (newest first), keeps a shorter page a prefix of a longer one, and flips hasMore exactly at the row count', async () => {
    const { db } = await createTestDb();
    const guids = await seedTiedChats(db);
    const expected = [...guids].reverse(); // id DESC: tie-7 … tie-1

    const full = await listChatsForInboxPage(db, { limit: 7 });
    expect(rowGuids(full.rows)).toEqual(expected);
    expect(full.hasMore).toBe(false);

    const six = await listChatsForInboxPage(db, { limit: 6 });
    expect(six.hasMore).toBe(true);
    expect(rowGuids(six.rows)).toEqual(expected.slice(0, 6));

    for (const limit of [1, 2, 3, 4, 5]) {
      const page = await listChatsForInboxPage(db, { limit });
      expect(page.hasMore).toBe(true);
      expect(rowGuids(page.rows)).toEqual(expected.slice(0, limit));
    }
  });

  it('puts pinned chats first regardless of the tie and keeps the rest in id order', async () => {
    const { db } = await createTestDb();
    const guids = await seedTiedChats(db);
    await setChatPin(db, guids[1]!, true); // tie-2
    await setChatPin(db, guids[4]!, true); // tie-5
    const page = await listChatsForInboxPage(db, { limit: 7 });
    const order = rowGuids(page.rows);
    expect(new Set(order.slice(0, 2))).toEqual(new Set([guids[1], guids[4]]));
    expect(order.slice(2)).toEqual([guids[6], guids[5], guids[3], guids[2], guids[0]]);
  });

  it('moves an archived chat out of the active page and count and into the archived view', async () => {
    const { db } = await createTestDb();
    const guids = await seedTiedChats(db);
    await setChatArchive(db, guids[3]!, true); // tie-4

    const active = await listChatsForInboxPage(db, { limit: 50 });
    expect(rowGuids(active.rows)).not.toContain(guids[3]);
    expect(active.rows).toHaveLength(6);
    expect(await countChatsForInbox(db)).toBe(6);
    expect(await countChatsForInbox(db, { archive: 'archived' })).toBe(1);
    expect(await countChatsForInbox(db, { archive: 'all' })).toBe(7);
    expect(
      rowGuids((await listChatsForInboxPage(db, { archive: 'archived', limit: 50 })).rows),
    ).toEqual([guids[3]]);
  });
});

describe('findChatsByParticipantAddresses', () => {
  async function seedServiceChats(db: TestDb): Promise<void> {
    const handles = await upsertHandles(db, [
      { address: ALICE, service: 'iMessage' },
      { address: BOB, service: 'iMessage' },
      { address: CAROL, service: 'SMS' },
    ]);
    await upsertChats(
      db,
      [
        Chat.parse({
          guid: `iMessage;-;${ALICE}`,
          style: 45,
          participants: [{ address: ALICE, service: 'iMessage' }],
        }),
        Chat.parse({
          guid: 'iMessage;+;group-1',
          style: 43,
          participants: [
            { address: ALICE, service: 'iMessage' },
            { address: BOB, service: 'iMessage' },
          ],
        }),
        Chat.parse({
          guid: `SMS;-;${CAROL}`,
          style: 45,
          participants: [{ address: CAROL, service: 'SMS' }],
        }),
      ],
      handles,
    );
  }

  it('matches only an all-iMessage chat whose participant set equals the wanted set', async () => {
    const { db } = await createTestDb();
    await seedServiceChats(db);
    expect(await findChatsByParticipantAddresses(db, [ALICE], 'iMessage')).toEqual([
      expect.objectContaining({ guid: `iMessage;-;${ALICE}`, isGroup: false }),
    ]);
    expect(await findChatsByParticipantAddresses(db, [ALICE, BOB], 'iMessage')).toEqual([
      expect.objectContaining({ guid: 'iMessage;+;group-1', isGroup: true }),
    ]);
    expect(await findChatsByParticipantAddresses(db, [BOB], 'iMessage')).toEqual([]); // no DM with Bob
    expect(await findChatsByParticipantAddresses(db, [CAROL], 'iMessage')).toEqual([]); // SMS handle
    expect(await findChatsByParticipantAddresses(db, [ALICE], 'RCS')).toEqual([]);
    expect(await findChatsByParticipantAddresses(db, [], 'iMessage')).toEqual([]);
  });
});

describe('participant lookups', () => {
  it('returns one row per participant handle with its linked contact, and reports a known sender only through that link', async () => {
    const { db, raw } = await createTestDb();
    const handles = await upsertHandles(db, [
      { address: ALICE, service: 'iMessage' },
      { address: BOB, service: 'iMessage' },
    ]);
    await upsertChats(
      db,
      [
        Chat.parse({
          guid: 'iMessage;+;pair',
          style: 43,
          participants: [
            { address: ALICE, service: 'iMessage' },
            { address: BOB, service: 'iMessage' },
          ],
        }),
        Chat.parse({
          guid: `iMessage;-;${BOB}`,
          style: 45,
          participants: [{ address: BOB, service: 'iMessage' }],
        }),
      ],
      handles,
    );
    const contactId = (raw as Database.Database)
      .prepare(
        "INSERT INTO contacts (source_id, display_name) VALUES ('contact-1', 'Alice') RETURNING id",
      )
      .get() as { id: number };
    raw.prepare('UPDATE handles SET contact_id = ? WHERE address = ?').run(contactId.id, ALICE);

    expect(await getChatParticipantContacts(db, 'iMessage;+;pair')).toEqual([
      { address: ALICE, service: 'iMessage', contactSourceId: 'contact-1' },
      { address: BOB, service: 'iMessage', contactSourceId: null },
    ]);
    expect(await chatHasKnownSender(db, 'iMessage;+;pair')).toBe(true);
    expect(await chatHasKnownSender(db, `iMessage;-;${BOB}`)).toBe(false);
    expect(await getChatIdByGuid(db, 'iMessage;+;pair')).toEqual(expect.any(Number));
    expect(await getChatIdByGuid(db, 'iMessage;-;nobody')).toBeNull();
  });
});
