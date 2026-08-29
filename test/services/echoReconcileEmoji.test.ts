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

  it('uses a known part to promote the matching optimistic reaction when kinds collide', async () => {
    const { db, raw } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    await seed(db);
    for (const partIndex of [0, 2]) {
      await insertOutgoingReaction(db, {
        tempGuid: `temp-part-${partIndex}`,
        chatGuid: 'cEmo',
        targetGuid: 'mt',
        reaction: 'love',
        partIndex,
        now: 4_000 + partIndex,
      });
      await markOutgoingSentNoGuid(db, `temp-part-${partIndex}`);
    }

    const echo = Message.parse({
      guid: 'react-real-part-two',
      isFromMe: true,
      dateCreated: 4_002,
      chats: [{ guid: 'cEmo' }],
      associatedMessageGuid: 'p:2/mt',
      associatedMessageType: 'love',
    });
    await router.handle('new-message', JSON.stringify(echo), 'socket');

    expect(
      raw
        .prepare('SELECT guid, associated_message_part AS part FROM messages WHERE guid LIKE ?')
        .all('temp-part-%'),
    ).toEqual([{ guid: 'temp-part-0', part: 0 }]);
    expect(
      raw
        .prepare(
          "SELECT associated_message_part AS part FROM messages WHERE guid = 'react-real-part-two'",
        )
        .get(),
    ).toEqual({ part: 2 });
  });

  it('does not guess an unknown part and keeps custom-emoji echo matching glyph-specific', async () => {
    const { db, raw } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    await seed(db);

    for (const partIndex of [0, 2]) {
      await insertOutgoingReaction(db, {
        tempGuid: `temp-unknown-part-${partIndex}`,
        chatGuid: 'cEmo',
        targetGuid: 'mt',
        reaction: 'love',
        partIndex,
        now: 5_000 + partIndex,
      });
      await markOutgoingSentNoGuid(db, `temp-unknown-part-${partIndex}`);
    }
    await router.handle(
      'new-message',
      JSON.stringify(
        Message.parse({
          guid: 'react-real-unknown-part',
          isFromMe: true,
          dateCreated: 5_002,
          chats: [{ guid: 'cEmo' }],
          associatedMessageGuid: 'mt',
          associatedMessageType: 'love',
        }),
      ),
      'socket',
    );
    expect(count(raw, "guid LIKE 'temp-unknown-part-%'")).toBe(2);

    for (const [suffix, emoji] of [
      ['fire', '🔥'],
      ['salute', '🫡'],
    ] as const) {
      await insertOutgoingReaction(db, {
        tempGuid: `temp-emoji-${suffix}`,
        chatGuid: 'cEmo',
        targetGuid: 'mt',
        reaction: 'emoji',
        emoji,
        now: 6_000,
      });
      await markOutgoingSentNoGuid(db, `temp-emoji-${suffix}`);
    }
    await router.handle(
      'new-message',
      JSON.stringify(
        Message.parse({
          guid: 'react-real-salute',
          isFromMe: true,
          dateCreated: 6_000,
          chats: [{ guid: 'cEmo' }],
          associatedMessageGuid: 'mt',
          associatedMessageType: 'emoji',
          associatedMessageEmoji: '🫡',
        }),
      ),
      'socket',
    );
    expect(count(raw, "guid = 'temp-emoji-fire'")).toBe(1);
    expect(count(raw, "guid = 'temp-emoji-salute'")).toBe(0);
    expect(count(raw, "guid = 'react-real-salute'")).toBe(1);
  });
});
