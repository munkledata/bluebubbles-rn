/**
 * Live-echo reconcile of the user's OWN emoji tapback: Gator's `new-message` echo carries no
 * tempGuid, so DbEventSink correlates our optimistic `temp-…` reaction row to the incoming real
 * message by CONTENT (associated_message_type + target guid) and promotes it in place. These
 * tests lock that the glyph survives the reconcile and that the reactions repo renders exactly
 * ONE own emoji badge afterward (no duplicate from the echo inserting a second row).
 */
import type Database from 'better-sqlite3';
import { Chat, Message } from '@core/models';
import { EventRouter } from '@core/realtime';
import {
  getChatIdByGuid,
  insertOutgoingReaction,
  listReactionsByMessageGuids,
  markOutgoingSentNoGuid,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { DbEventSink } from '@/services/realtime/dbEventSink';
import { createTestDb } from '../support/testDb';

async function seed(db: AppDatabase): Promise<number> {
  const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
  const map = await upsertChats(
    db,
    [Chat.parse({ guid: 'cEmo', participants: [{ address: 'a@x.com' }] })],
    hm,
  );
  const chatId = map.get('cEmo')!;
  await upsertMessages(
    db,
    [Message.parse({ guid: 'mt', text: 'hi', dateCreated: 1000, handle: { address: 'a@x.com' } })],
    () => chatId,
    hm,
  );
  return chatId;
}

const count = (raw: Database.Database, where: string, ...args: unknown[]): number =>
  (raw.prepare(`SELECT COUNT(*) c FROM messages WHERE ${where}`).get(...args) as { c: number }).c;

describe('live echo reconcile — emoji tapback', () => {
  it('promotes the optimistic emoji row in place; glyph survives + one own badge (no duplicate)', async () => {
    const { db, raw } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    const chatId = await seed(db);

    // Optimistic emoji tapback (no-guid ack path — identity stays the tempGuid until the echo).
    await insertOutgoingReaction(db, {
      tempGuid: 'temp-emo11111',
      chatId,
      chatGuid: 'cEmo',
      targetGuid: 'mt',
      reaction: 'emoji',
      emoji: '🔥',
      selectedMessageText: 'hi',
      now: 2000,
    });
    await markOutgoingSentNoGuid(db, 'temp-emo11111');

    // The live echo of our OWN tapback lands: real guid, same target+type, carrying the glyph.
    const echo = Message.parse({
      guid: 'react-real-1',
      isFromMe: true,
      dateCreated: 2000,
      chats: [{ guid: 'cEmo' }],
      associatedMessageGuid: 'mt',
      associatedMessageType: 'emoji',
      associatedMessageEmoji: '🔥',
    });
    await router.handle('new-message', JSON.stringify(echo), 'socket');

    // Promoted in place: exactly one reaction row targeting 'mt', now under the real guid.
    expect(count(raw, "associated_message_guid = 'mt'")).toBe(1);
    expect(count(raw, "guid = 'temp-emo11111'")).toBe(0); // temp promoted, not left behind
    const row = raw
      .prepare(
        "SELECT send_state s, associated_message_emoji e FROM messages WHERE guid = 'react-real-1'",
      )
      .get() as { s: string; e: string };
    expect(row.s).toBe('sent');
    expect(row.e).toBe('🔥'); // glyph survived the promote + upsert COALESCE

    // The reactions repo renders exactly ONE own emoji badge with the glyph (no duplicate).
    const badges = (await listReactionsByMessageGuids(db, ['mt'])).get('mt') ?? [];
    expect(badges).toHaveLength(1);
    expect(badges[0]).toMatchObject({ baseType: 'emoji', emoji: '🔥', isFromMe: 1 });
  });

  it('ack-promoted-first then echo is idempotent (glyph intact, still one badge)', async () => {
    const { db } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    const chatId = await seed(db);

    // Optimistic row already promoted to its real guid by the HTTP ack (upsert simulates it).
    await insertOutgoingReaction(db, {
      tempGuid: 'temp-emo22222',
      chatId,
      chatGuid: 'cEmo',
      targetGuid: 'mt',
      reaction: 'emoji',
      emoji: '🫡',
      now: 3000,
    });
    // Promote via a real-guid upsert (as reconcileOutgoingSuccess would, then upsert on echo).
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'react-real-2',
          isFromMe: true,
          dateCreated: 3000,
          chats: [{ guid: 'cEmo' }],
          associatedMessageGuid: 'mt',
          associatedMessageType: 'emoji',
          associatedMessageEmoji: '🫡',
        }),
      ],
      () => chatId,
      new Map(),
    );

    // A later echo of the SAME real guid must be an idempotent no-op (reconcileEchoByContent
    // sees the real guid already present → returns; upsert COALESCE keeps the glyph).
    const echo = Message.parse({
      guid: 'react-real-2',
      isFromMe: true,
      dateCreated: 3000,
      chats: [{ guid: 'cEmo' }],
      associatedMessageGuid: 'mt',
      associatedMessageType: 'emoji',
      associatedMessageEmoji: '🫡',
    });
    await router.handle('new-message', JSON.stringify(echo), 'socket');

    const badges = (await listReactionsByMessageGuids(db, ['mt'])).get('mt') ?? [];
    expect(badges).toHaveLength(1);
    expect(badges[0]).toMatchObject({ baseType: 'emoji', emoji: '🫡', isFromMe: 1 });
  });
});
