/**
 * Tapback notifications (fix plan 2.2). As on an iPhone, someone else's tapback on a message YOU
 * sent raises a line such as `Loved “dinner at 7?”`; nothing else about tapbacks notifies. The
 * posting rule (`buildMessageIntents`) and the tray rebuild (`listMessageNotificationTruth`) share
 * one SQL rule, so both are pinned here against a real SQLite database: a line the poster raised
 * must survive the rebuild, and a line the rule no longer allows must go.
 */
import type Database from 'better-sqlite3';
import { Chat, Message } from '@core/models';
import type { NormalizedEvent, NotificationIntent } from '@core/realtime';
import { buildMessageIntents } from '@/services/notifications/intents';
import { listMessageNotificationTruth } from '@/services/notifications/notificationRouting';
import {
  deleteChatLocal,
  getChatIdByGuid,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';
import { setChatMute } from '../support/repositoryWrappers';

const ANN = { address: 'ann@x.com' };
const BOB = { address: 'bob@x.com' };

interface Fixture {
  db: AppDatabase;
  raw: Database.Database;
  chatId: number;
  handles: Map<string, number>;
}

async function seed(people = [ANN]): Promise<Fixture> {
  const { db, raw } = await createTestDb();
  const handles = await upsertHandles(db, people);
  await upsertChats(db, [Chat.parse({ guid: 'c1', participants: people })], handles);
  return { db, raw, chatId: (await getChatIdByGuid(db, 'c1'))!, handles };
}

/** Store one message row in chat `c1`. */
async function put(f: Fixture, fields: Record<string, unknown>): Promise<Message> {
  const message = Message.parse({ chats: [{ guid: 'c1' }], ...fields });
  await upsertMessages(f.db, [message], () => f.chatId, f.handles);
  return message;
}

/** Your own message, the usual tapback target. */
function putMine(f: Fixture, fields: Record<string, unknown> = {}): Promise<Message> {
  return put(f, {
    guid: 'mine',
    text: 'dinner at 7?',
    isFromMe: true,
    dateCreated: 1000,
    ...fields,
  });
}

/** Store an incoming tapback (from Ann unless `handle` says otherwise), then derive its notices. */
async function receive(
  f: Fixture,
  fields: Record<string, unknown>,
): Promise<{ intents: NotificationIntent[]; message: Message }> {
  const message = await put(f, { isFromMe: false, handle: ANN, ...fields });
  return { intents: await rebuild(f, message), message };
}

/** Derive notices again for a stored event, as a durable retry does. */
function rebuild(f: Fixture, message: Message): Promise<NotificationIntent[]> {
  return buildMessageIntents(f.db, { type: 'new-message', message } as NormalizedEvent);
}

function localId(f: Fixture, guid: string): number {
  return (f.raw.prepare('SELECT id FROM messages WHERE guid = ?').get(guid) as { id: number }).id;
}

/** Whether the tray rebuild keeps the line for this stored message. */
async function trayKeeps(f: Fixture, guid: string): Promise<boolean> {
  const [truth] = await listMessageNotificationTruth([localId(f, guid)], f.db);
  return truth?.notificationEligible === 1;
}

/** Your photo (part 0) with its caption (part 1). */
const PHOTO_AND_CAPTION = {
  text: 'look at this',
  messagePartTopology: {
    complete: true,
    originalPartIndexes: [0, 1],
    currentParts: [
      { index: 0, kind: 'attachment', attachmentGuids: ['photo-1'] },
      { index: 1, kind: 'text' },
    ],
    attachmentOwnership: [{ attachmentGuid: 'photo-1', partIndex: 0 }],
  },
  attachments: [{ guid: 'photo-1', mimeType: 'image/jpeg' }],
};

function love(guid: string, dateCreated: number, target = 'p:0/mine') {
  return { guid, dateCreated, associatedMessageType: 'love', associatedMessageGuid: target };
}

describe('tapback notifications', () => {
  it('notifies for a tapback on your message, worded as on an iPhone', async () => {
    const f = await seed();
    await putMine(f);

    const { intents } = await receive(f, love('tb-love', 2000));

    expect(intents).toEqual([
      expect.objectContaining({
        kind: 'message',
        chatGuid: 'c1',
        body: 'Loved “dinner at 7?”',
        messageGuid: 'tb-love',
        timestamp: 2000,
        isGroup: false,
        tapback: true,
      }),
    ]);
    expect(await trayKeeps(f, 'tb-love')).toBe(true);
  });

  it('names the emoji of an emoji tapback', async () => {
    const f = await seed();
    await putMine(f);

    const { intents } = await receive(f, {
      guid: 'tb-emoji',
      dateCreated: 2000,
      associatedMessageType: 'emoji',
      associatedMessageEmoji: '😂',
      associatedMessageGuid: 'p:0/mine',
    });

    expect(intents).toEqual([expect.objectContaining({ body: 'Reacted 😂 to “dinner at 7?”' })]);
  });

  it('stays silent for a tapback on someone else’s message', async () => {
    const f = await seed([ANN, BOB]);
    await put(f, { guid: 'bobs', text: 'pizza?', isFromMe: false, handle: BOB, dateCreated: 1000 });

    const { intents } = await receive(f, love('tb-other', 2000, 'p:0/bobs'));

    expect(intents).toEqual([]);
    expect(await trayKeeps(f, 'tb-other')).toBe(false);
  });

  it('never notifies for a removal, and a removed tapback stops notifying', async () => {
    const f = await seed();
    await putMine(f);
    const first = await receive(f, love('tb-1', 2000));
    expect(first.intents).toHaveLength(1);

    const removal = await receive(f, {
      guid: 'tb-2',
      dateCreated: 3000,
      associatedMessageType: '-love',
      associatedMessageGuid: 'p:0/mine',
    });

    expect(removal.intents).toEqual([]);
    // A late retry of the first tapback, and the tray line it posted, both follow the removal.
    expect(await rebuild(f, first.message)).toEqual([]);
    expect(await trayKeeps(f, 'tb-1')).toBe(false);
  });

  it('notifies again for a tapback added back after a removal', async () => {
    const f = await seed();
    await putMine(f);
    await receive(f, love('tb-1', 2000));
    await receive(f, {
      guid: 'tb-2',
      dateCreated: 3000,
      associatedMessageType: '-love',
      associatedMessageGuid: 'p:0/mine',
    });

    const readded = await receive(f, love('tb-3', 4000));

    expect(readded.intents).toEqual([expect.objectContaining({ messageGuid: 'tb-3' })]);
  });

  it('keeps a different kind or part from the same person apart', async () => {
    const f = await seed();
    await putMine(f);
    await receive(f, love('tb-love', 2000));

    // Ann also likes the message. A like is not a removal of the love, so both lines stay.
    const like = await receive(f, {
      guid: 'tb-like',
      dateCreated: 3000,
      associatedMessageType: 'like',
      associatedMessageGuid: 'p:0/mine',
    });

    expect(like.intents).toEqual([expect.objectContaining({ body: 'Liked “dinner at 7?”' })]);
    expect(await trayKeeps(f, 'tb-love')).toBe(true);
  });

  it('keeps two different emoji from the same person apart', async () => {
    const f = await seed();
    await putMine(f);
    const emoji = (guid: string, dateCreated: number, glyph: string) => ({
      guid,
      dateCreated,
      associatedMessageType: 'emoji',
      associatedMessageEmoji: glyph,
      associatedMessageGuid: 'p:0/mine',
    });
    await receive(f, emoji('tb-laugh', 2000, '😂'));

    const party = await receive(f, emoji('tb-party', 3000, '🎉'));

    expect(party.intents).toEqual([
      expect.objectContaining({ body: 'Reacted 🎉 to “dinner at 7?”' }),
    ]);
    expect(await trayKeeps(f, 'tb-laugh')).toBe(true);
  });

  it('removes only the tapback on the part it was removed from', async () => {
    const f = await seed();
    await putMine(f, PHOTO_AND_CAPTION);
    await receive(f, love('tb-photo', 2000, 'p:0/mine'));
    await receive(f, love('tb-caption', 2100, 'p:1/mine'));

    await receive(f, {
      guid: 'tb-unlove-photo',
      dateCreated: 3000,
      associatedMessageType: '-love',
      associatedMessageGuid: 'p:0/mine',
    });

    expect(await trayKeeps(f, 'tb-photo')).toBe(false);
    expect(await trayKeeps(f, 'tb-caption')).toBe(true);
  });

  it('stays silent in a muted chat', async () => {
    const f = await seed();
    await putMine(f);
    await setChatMute(f.db, 'c1', 'mute');

    const { intents } = await receive(f, love('tb-muted', 2000));

    expect(intents).toEqual([]);
    expect(await trayKeeps(f, 'tb-muted')).toBe(false);
  });

  it('stops once the chat is read past the tapback', async () => {
    const f = await seed();
    await putMine(f);
    const { message } = await receive(f, love('tb-read', 2000));
    f.raw
      .prepare('UPDATE chats SET last_read_message_guid = ? WHERE guid = ?')
      .run('tb-read', 'c1');

    expect(await rebuild(f, message)).toEqual([]);
    expect(await trayKeeps(f, 'tb-read')).toBe(false);
  });

  it('stays silent once your message is unsent', async () => {
    const f = await seed();
    await putMine(f, { dateRetracted: 1500 });

    const { intents } = await receive(f, love('tb-unsent', 2000));

    expect(intents).toEqual([]);
    expect(await trayKeeps(f, 'tb-unsent')).toBe(false);
  });

  it('stays silent in a chat deleted on this phone', async () => {
    const f = await seed();
    await putMine(f);
    await deleteChatLocal(f.db, 'c1', 1500);

    const { intents } = await receive(f, love('tb-deleted', 2000));

    expect(intents).toEqual([]);
  });

  it('notifies on a message you sent after deleting the chat, which brought it back', async () => {
    // An optimistic send bypasses ingress, so the chat can keep its deletion stamp while your new
    // message exists (see chatUnreadMessagePredicateSql). The tapback's own ingress retires the
    // stamp, because your newer message brought the chat back, so the tapback notifies as usual.
    // (The rule's `deleted_at IS NULL` check is a backstop: no reachable state reaches it with a
    // live target, since deleting the chat removes every message in it.)
    const f = await seed();
    await putMine(f, { dateCreated: 1600 });
    f.raw.prepare('UPDATE chats SET deleted_at = ? WHERE guid = ?').run(1500, 'c1');

    const { intents } = await receive(f, love('tb-after-delete', 2000));

    const chat = f.raw
      .prepare('SELECT deleted_at AS deletedAt FROM chats WHERE guid = ?')
      .get('c1');
    expect(chat).toEqual({ deletedAt: null });
    expect(intents).toEqual([expect.objectContaining({ messageGuid: 'tb-after-delete' })]);
  });

  it('never notifies for a sticker, a target that isn’t stored, or your own tapback', async () => {
    const f = await seed();
    await putMine(f);

    const sticker = await receive(f, {
      guid: 'tb-sticker',
      dateCreated: 2000,
      associatedMessageType: 'sticker',
      associatedMessageGuid: 'p:0/mine',
    });
    const missing = await receive(f, love('tb-missing', 2100, 'p:0/not-stored'));
    const own = await put(f, { ...love('tb-own', 2200), isFromMe: true });

    expect(sticker.intents).toEqual([]);
    expect(missing.intents).toEqual([]);
    expect((await rebuild(f, own)).filter((intent) => intent.kind === 'message')).toEqual([]);
    expect(await trayKeeps(f, 'tb-own')).toBe(false);
  });

  it('never notifies for an emoji tapback that lost its emoji', async () => {
    // The chat can't draw a glyph-less emoji tapback either (listReactionsByMessageGuids skips it).
    const f = await seed();
    await putMine(f);

    const { intents } = await receive(f, {
      guid: 'tb-no-glyph',
      dateCreated: 2000,
      associatedMessageType: 'emoji',
      associatedMessageGuid: 'p:0/mine',
    });

    expect(intents).toEqual([]);
    expect(await trayKeeps(f, 'tb-no-glyph')).toBe(false);
  });

  it('quotes the exact part that was tapbacked', async () => {
    const f = await seed();
    await putMine(f, PHOTO_AND_CAPTION);

    const onCaption = await receive(f, love('tb-caption', 2000, 'p:1/mine'));
    const onPhoto = await receive(f, love('tb-photo', 2100, 'p:0/mine'));

    expect(onCaption.intents).toEqual([expect.objectContaining({ body: 'Loved “look at this”' })]);
    expect(onPhoto.intents).toEqual([expect.objectContaining({ body: 'Loved an attachment' })]);
  });

  it('withdraws tapback lines once part of your message is unsent', async () => {
    const f = await seed();
    await putMine(f, PHOTO_AND_CAPTION);
    const before = await receive(f, love('tb-caption', 2000, 'p:1/mine'));
    expect(before.intents).toHaveLength(1);

    // You unsend the photo and keep the caption.
    await putMine(f, {
      ...PHOTO_AND_CAPTION,
      dateRetracted: 2500,
      messageSummaryInfo: { retractedParts: [0] },
      messagePartTopology: {
        ...PHOTO_AND_CAPTION.messagePartTopology,
        currentParts: [{ index: 1, kind: 'text' }],
      },
    });
    const state = f.raw
      .prepare('SELECT retraction_state AS state FROM messages WHERE guid = ?')
      .get('mine') as { state: string };
    expect(state.state).toBe('partial');

    // The line quoting your message goes, and a new tapback on it stays silent: a partly unsent
    // target fails closed rather than risk quoting a part that is gone.
    expect(await trayKeeps(f, 'tb-caption')).toBe(false);
    const later = await receive(f, {
      guid: 'tb-later',
      dateCreated: 3000,
      associatedMessageType: 'like',
      associatedMessageGuid: 'p:1/mine',
    });
    expect(later.intents).toEqual([]);
  });

  it('quotes nothing when the wire names no part', async () => {
    const f = await seed();
    await putMine(f);

    // The legacy `bp:` form carries no part number, so the line can't prove what to quote.
    const { intents } = await receive(f, love('tb-bp', 2000, 'bp:mine'));

    expect(intents).toEqual([expect.objectContaining({ body: 'Loved a message' })]);
  });

  it('leaves ordinary message lines to the unread rule', async () => {
    const f = await seed();
    await put(f, { guid: 'hello', text: 'hello', isFromMe: false, handle: ANN, dateCreated: 2000 });
    expect(await trayKeeps(f, 'hello')).toBe(true);

    await setChatMute(f.db, 'c1', 'mute');

    expect(await trayKeeps(f, 'hello')).toBe(false);
  });
});
