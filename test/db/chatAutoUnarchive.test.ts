/**
 * A new message from someone else brings an archived chat back to the inbox (owner decision
 * 2026-11-05), unless the chat's own switch is off. Only a message NEWER than when the chat was
 * archived counts, so re-synced history never un-archives anything.
 */
import { Chat, Message } from '@core/models';
import { upsertChats, upsertHandles, upsertMessages } from '@db/repositories';
import { setChatAutoUnarchiveWithinTransaction } from '@db/repositories/chats';
import { withDbTransaction } from '@db/transaction';
import { createTestDb } from '../support/testDb';
import { setChatArchive, setChatMute } from '../support/repositoryWrappers';

type Db = Awaited<ReturnType<typeof createTestDb>>;

const ADDRESS = '+15551234567';
const ARCHIVED_AT = 1_800_000_000_000;

async function seed(t: Db, guid = 'iMessage;-;+15551234567') {
  const handles = await upsertHandles(t.db, [{ address: ADDRESS }]);
  const map = await upsertChats(
    t.db,
    [Chat.parse({ guid, style: 45, participants: [{ address: ADDRESS }] })],
    handles,
  );
  return { guid, chatId: map.get(guid)!, handles };
}

async function receive(
  t: Db,
  chat: Awaited<ReturnType<typeof seed>>,
  message: Partial<{
    guid: string;
    date: number;
    fromMe: boolean;
    associatedMessageType: string;
    associatedMessageGuid: string;
    itemType: number;
    groupActionType: number;
    dateRetracted: number;
  }>,
) {
  await receiveBatch(t, chat, [message]);
}

async function receiveBatch(
  t: Db,
  chat: Awaited<ReturnType<typeof seed>>,
  batch: Parameters<typeof receive>[2][],
) {
  await upsertMessages(
    t.db,
    batch.map((message) =>
      Message.parse({
        guid: message.guid ?? `m-${message.date}`,
        text: 'hello',
        isFromMe: message.fromMe ?? false,
        dateCreated: message.date ?? ARCHIVED_AT + 1_000,
        originalROWID: message.date ?? ARCHIVED_AT + 1_000,
        handle: message.fromMe ? null : { address: ADDRESS },
        associatedMessageType: message.associatedMessageType,
        associatedMessageGuid: message.associatedMessageGuid,
        itemType: message.itemType,
        groupActionType: message.groupActionType,
        dateRetracted: message.dateRetracted,
      }),
    ),
    () => chat.chatId,
    chat.handles,
  );
}

/** Archive the chat, then pin its archive time so the "newer than" checks don't use the clock. */
async function archiveAt(t: Db, guid: string, at = ARCHIVED_AT) {
  await setChatArchive(t.db, guid, true);
  t.raw.prepare('UPDATE chats SET archived_at = ? WHERE guid = ?').run(at, guid);
}

function chatRow(t: Db, guid: string) {
  return t.raw
    .prepare(
      'SELECT is_archived AS archived, archived_at AS archivedAt, auto_unarchive AS auto, mute_type AS mute FROM chats WHERE guid = ?',
    )
    .get(guid) as {
    archived: number;
    archivedAt: number | null;
    auto: number;
    mute: string | null;
  };
}

describe('archived_at is stamped however a chat is archived', () => {
  it('stamps on archive and clears on un-archive', async () => {
    const t = await createTestDb();
    const chat = await seed(t);
    const before = Date.now();
    await setChatArchive(t.db, chat.guid, true);
    const archived = chatRow(t, chat.guid);
    expect(archived.archived).toBe(1);
    expect(archived.archivedAt).toBeGreaterThanOrEqual(before - 1_000);

    await setChatArchive(t.db, chat.guid, false);
    expect(chatRow(t, chat.guid)).toMatchObject({ archived: 0, archivedAt: null });
  });

  it('stamps a chat inserted already archived', async () => {
    const t = await createTestDb();
    t.raw
      .prepare("INSERT INTO chats (guid, style, is_archived) VALUES ('raw-archived', 45, 1)")
      .run();
    expect(chatRow(t, 'raw-archived').archivedAt).not.toBeNull();
  });

  it('defaults the switch on for every chat', async () => {
    const t = await createTestDb();
    const chat = await seed(t);
    expect(chatRow(t, chat.guid).auto).toBe(1);
  });
});

describe('a new message brings an archived chat back', () => {
  it('un-archives on a newer message from someone else', async () => {
    const t = await createTestDb();
    const chat = await seed(t);
    await archiveAt(t, chat.guid);
    await receive(t, chat, { date: ARCHIVED_AT + 1_000 });
    expect(chatRow(t, chat.guid)).toMatchObject({ archived: 0, archivedAt: null });
  });

  it('brings a muted chat back but keeps it muted', async () => {
    const t = await createTestDb();
    const chat = await seed(t);
    await setChatMute(t.db, chat.guid, 'mute');
    await archiveAt(t, chat.guid);
    await receive(t, chat, {});
    expect(chatRow(t, chat.guid)).toMatchObject({ archived: 0, mute: 'mute' });
  });

  it.each([
    ['re-synced history older than the archive', { date: ARCHIVED_AT - 1_000 }],
    ['a message at the exact archive moment', { date: ARCHIVED_AT }],
    ['your own message', { fromMe: true }],
    ['a reaction', { associatedMessageType: 'love', associatedMessageGuid: 'p:0/m-original' }],
    ['a group event', { itemType: 1, groupActionType: 0 }],
  ] as const)('stays archived for %s', async (_label, message) => {
    const t = await createTestDb();
    const chat = await seed(t);
    await archiveAt(t, chat.guid);
    await receive(t, chat, message);
    // The message really was stored; only the rule declined to un-archive for it.
    expect(
      t.raw.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get(chat.chatId),
    ).toEqual({ n: 1 });
    expect(chatRow(t, chat.guid)).toMatchObject({ archived: 1, archivedAt: ARCHIVED_AT });
  });

  it('stays archived when the chat switch is off', async () => {
    const t = await createTestDb();
    const chat = await seed(t);
    await archiveAt(t, chat.guid);
    await withDbTransaction(t.db, (db, context) =>
      setChatAutoUnarchiveWithinTransaction(context, chat.guid, false),
    );
    await receive(t, chat, {});
    expect(chatRow(t, chat.guid)).toMatchObject({ archived: 1, auto: 0 });
  });

  it('stays archived when the archive time is unknown', async () => {
    const t = await createTestDb();
    const chat = await seed(t);
    await setChatArchive(t.db, chat.guid, true);
    t.raw.prepare('UPDATE chats SET archived_at = NULL WHERE guid = ?').run(chat.guid);
    await receive(t, chat, {});
    expect(chatRow(t, chat.guid).archived).toBe(1);
  });

  it('leaves chats that were never archived alone', async () => {
    const t = await createTestDb();
    const chat = await seed(t);
    await receive(t, chat, {});
    expect(chatRow(t, chat.guid)).toMatchObject({ archived: 0, archivedAt: null });
  });
});

describe('only messages this batch adds can bring a chat back (independent review)', () => {
  it('a reaction after the switch is turned back on does not count earlier messages', async () => {
    const t = await createTestDb();
    const chat = await seed(t);
    await archiveAt(t, chat.guid);
    await withDbTransaction(t.db, (db, context) =>
      setChatAutoUnarchiveWithinTransaction(context, chat.guid, false),
    );
    await receive(t, chat, { guid: 'while-off', date: ARCHIVED_AT + 1_000 });
    await withDbTransaction(t.db, (db, context) =>
      setChatAutoUnarchiveWithinTransaction(context, chat.guid, true),
    );

    await receive(t, chat, {
      guid: 'tapback',
      date: ARCHIVED_AT + 2_000,
      associatedMessageType: 'love',
      associatedMessageGuid: 'p:0/while-off',
    });
    await receive(t, chat, { guid: 'own-reply', date: ARCHIVED_AT + 3_000, fromMe: true });
    expect(chatRow(t, chat.guid).archived).toBe(1);

    await receive(t, chat, { guid: 'next-message', date: ARCHIVED_AT + 4_000 });
    expect(chatRow(t, chat.guid).archived).toBe(0);
  });

  it('re-saving a message already stored never un-archives (sync re-pass, edit)', async () => {
    const t = await createTestDb();
    const chat = await seed(t);
    await archiveAt(t, chat.guid);
    await withDbTransaction(t.db, (db, context) =>
      setChatAutoUnarchiveWithinTransaction(context, chat.guid, false),
    );
    await receive(t, chat, { guid: 'stored', date: ARCHIVED_AT + 1_000 });
    await withDbTransaction(t.db, (db, context) =>
      setChatAutoUnarchiveWithinTransaction(context, chat.guid, true),
    );
    await receive(t, chat, { guid: 'stored', date: ARCHIVED_AT + 1_000 });
    expect(chatRow(t, chat.guid).archived).toBe(1);
  });

  it('a Mac clock running ahead cannot make an already-shown message count', async () => {
    const t = await createTestDb();
    const chat = await seed(t);
    const ahead = Date.now() + 60_000; // the Mac stamps this message a minute in the phone's future
    await receive(t, chat, { guid: 'already-here', date: ahead });
    await setChatArchive(t.db, chat.guid, true);
    expect(chatRow(t, chat.guid).archivedAt).toBeGreaterThanOrEqual(ahead);

    await receive(t, chat, { guid: 'own-reply', date: ahead + 1_000, fromMe: true });
    expect(chatRow(t, chat.guid).archived).toBe(1);
    await receive(t, chat, { guid: 'real-new', date: ahead + 2_000 });
    expect(chatRow(t, chat.guid).archived).toBe(0);
  });

  it('a batch with old and new messages un-archives on the new one', async () => {
    const t = await createTestDb();
    const chat = await seed(t);
    await archiveAt(t, chat.guid);
    await receiveBatch(t, chat, [
      { guid: 'old', date: ARCHIVED_AT - 5_000 },
      { guid: 'new', date: ARCHIVED_AT + 5_000 },
    ]);
    expect(chatRow(t, chat.guid).archived).toBe(0);
  });

  it('a retracted (unsent) new message does not count', async () => {
    const t = await createTestDb();
    const chat = await seed(t);
    await archiveAt(t, chat.guid);
    await receive(t, chat, {
      guid: 'unsent',
      date: ARCHIVED_AT + 1_000,
      dateRetracted: ARCHIVED_AT + 2_000,
    });
    expect(
      t.raw.prepare('SELECT COUNT(*) AS n FROM messages WHERE guid = ?').get('unsent'),
    ).toEqual({ n: 1 });
    expect(chatRow(t, chat.guid).archived).toBe(1);
  });
});

describe('sync writes and archived_at (release-owner review)', () => {
  it('a sync insert of a chat the server reports archived is stamped, and a re-sync leaves it', async () => {
    const t = await createTestDb();
    const handles = await upsertHandles(t.db, [{ address: ADDRESS }]);
    const guid = 'iMessage;-;synced-archived';
    const chat = Chat.parse({
      guid,
      style: 45,
      isArchived: true,
      participants: [{ address: ADDRESS }],
    });
    const before = Date.now();
    await upsertChats(t.db, [chat], handles);
    const stamped = chatRow(t, guid);
    expect(stamped.archived).toBe(1);
    expect(stamped.archivedAt).toBeGreaterThanOrEqual(before - 1_000);

    // Pin the stamp, then re-sync: is_archived is device-local, so the conflict path never rewrites
    // it and the update trigger must not fire.
    t.raw.prepare('UPDATE chats SET archived_at = ? WHERE guid = ?').run(ARCHIVED_AT, guid);
    await upsertChats(t.db, [Chat.parse({ ...chat, isArchived: false })], handles);
    expect(chatRow(t, guid)).toMatchObject({ archived: 1, archivedAt: ARCHIVED_AT });
  });
});
