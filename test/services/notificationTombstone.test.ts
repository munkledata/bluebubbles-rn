/**
 * `buildMessageIntents` vs the local deletion tombstone.
 *
 * A chat the user deleted is hidden from the inbox, the archived list, unknown senders and search,
 * and only a message that satisfies `chatVisible` — real content, newer than the stamp — brings it
 * back. The notification layer has to answer with the SAME rule, or the two disagree in the one
 * direction that is impossible to recover from: an alert with the contact's name and photo for a
 * conversation that stays unreachable, whose only route is the notification itself.
 *
 * The other half of the contract is that `getChatHeader` stays UNFILTERED: it reports the stamp but
 * is not hidden by it, because a null header reads as "not muted" downstream. These cases pin both.
 */
import { Chat, Message } from '@core/models';
import type { NormalizedEvent } from '@core/realtime';
import { buildMessageIntents } from '@/services/notifications/intents';
import {
  deleteChatLocal,
  getChatIdByGuid,
  setChatMute,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

/** An inbound event for chat `c1` from Bob, with whatever message fields the case needs. */
function inbound(fields: Record<string, unknown>): NormalizedEvent {
  return {
    type: 'new-message',
    message: Message.parse({
      isFromMe: false,
      handle: { address: 'bob@x.com', displayName: 'Bob' },
      chats: [{ guid: 'c1' }],
      ...fields,
    }),
  };
}

async function seedDeletedChat(): Promise<AppDatabase> {
  const { db } = await createTestDb();
  const handles = await upsertHandles(db, [{ address: 'bob@x.com' }]);
  await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: [{ address: 'bob@x.com' }] })],
    handles,
  );
  const chatId = (await getChatIdByGuid(db, 'c1'))!;
  await upsertMessages(
    db,
    [Message.parse({ guid: 'old', text: 'old', dateCreated: 1000, isFromMe: false })],
    () => chatId,
    handles,
  );
  await deleteChatLocal(db, 'c1', 5000);
  return db;
}

describe('buildMessageIntents + a deleted chat', () => {
  it('stays silent for a tapback — it can never make the chat findable again', async () => {
    const db = await seedDeletedChat();
    // The other party has no idea the thread was deleted, and tapbacks are routine. A reaction row
    // has no content of its own, so `chatVisible` refuses to un-hide on it.
    const intents = await buildMessageIntents(
      db,
      inbound({
        guid: 'rx',
        dateCreated: 9000,
        associatedMessageType: '2000',
        associatedMessageGuid: 'old',
      }),
    );
    expect(intents).toEqual([]);
  });

  it('stays silent for an unsent (retracted) message', async () => {
    const db = await seedDeletedChat();
    const intents = await buildMessageIntents(
      db,
      inbound({ guid: 'gone', text: 'oops', dateCreated: 9000, dateRetracted: 9100 }),
    );
    expect(intents).toEqual([]);
  });

  it('stays silent for re-synced history that predates the deletion', async () => {
    const db = await seedDeletedChat();
    const intents = await buildMessageIntents(
      db,
      inbound({ guid: 'old', text: 'old', dateCreated: 1000 }),
    );
    expect(intents).toEqual([]);
  });

  it('DOES notify for genuinely new content — that message brings the chat back', async () => {
    const db = await seedDeletedChat();
    const intents = await buildMessageIntents(
      db,
      inbound({ guid: 'new', text: 'hello again', dateCreated: 6000 }),
    );
    expect(intents).toHaveLength(1);
    const i = intents[0]!;
    expect(i.kind).toBe('message');
    if (i.kind === 'message') expect(i.body).toBe('hello again');
  });

  it('does not suppress anything in a chat that was never deleted', async () => {
    const { db } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'bob@x.com' }]);
    await upsertChats(
      db,
      [Chat.parse({ guid: 'c1', participants: [{ address: 'bob@x.com' }] })],
      handles,
    );
    // Deliberately OLDER than the tombstone value used above: with no stamp there is no floor.
    const intents = await buildMessageIntents(
      db,
      inbound({ guid: 'n1', text: 'yo', dateCreated: 1000 }),
    );
    expect(intents).toHaveLength(1);
  });

  it('still honours MUTE on a deleted chat — the tombstone must not shadow the header lookup', async () => {
    const db = await seedDeletedChat();
    await setChatMute(db, 'c1', 'mute');
    // A muted chat is silent for a qualifying message too; if `getChatHeader` were filtered by the
    // tombstone the header would be null, which reads as "not muted", and the chat would buzz.
    const intents = await buildMessageIntents(
      db,
      inbound({ guid: 'new', text: 'hello again', dateCreated: 6000 }),
    );
    expect(intents).toEqual([]);
  });

  it('notifies for a chat guid we have never seen (no header ⇒ no tombstone to apply)', async () => {
    const db = await seedDeletedChat();
    const intents = await buildMessageIntents(db, {
      type: 'new-message',
      message: Message.parse({
        guid: 'u1',
        text: 'hi',
        dateCreated: 1,
        isFromMe: false,
        handle: { address: 'zoe@x.com' },
        chats: [{ guid: 'unknown-chat' }],
      }),
    });
    expect(intents).toHaveLength(1);
  });
});
