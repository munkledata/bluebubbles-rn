/**
 * Emoji-tapback crash-recovery: the outgoing-queue retry processor (runOutgoingQueue)
 * must re-POST a stranded/failed emoji tapback as a FULL emoji reaction — carrying
 * reactionType 'emoji'/'-emoji' PLUS the reactionEmoji glyph — while a CLASSIC tapback
 * retry must NOT carry the reactionEmoji key (the server's schema rejects it). This locks
 * the queue-payload round-trip (insertOutgoingReaction → JSON payload → resend →
 * sendReaction wire body) against a regression that would drop the glyph on retry.
 */
import type Database from 'better-sqlite3';
import type { HttpClient } from '@core/api/http';
import { Chat, Message } from '@core/models';
import {
  getChatIdByGuid,
  insertOutgoingReaction,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { runOutgoingQueue } from '@/services/send/outgoingQueueService';
import { createTestDb } from '../support/testDb';

function fakeHttp(impl: (json?: unknown) => Promise<unknown>): HttpClient {
  return {
    post: (_p: string, _s: unknown, opts?: { json?: unknown }) => impl(opts?.json),
  } as unknown as HttpClient;
}

async function seed(db: AppDatabase): Promise<number> {
  const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
  const map = await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: [{ address: 'a@x.com' }] })],
    hm,
  );
  const chatId = map.get('c1')!;
  await upsertMessages(
    db,
    [Message.parse({ guid: 'mt', text: 'hi', dateCreated: 100, handle: { address: 'a@x.com' } })],
    () => chatId,
    hm,
  );
  return chatId;
}

/**
 * Seed a FAILED tapback: an optimistic reaction row + its queue row, then force it into the
 * already-failed/eligible state (attempts=1, backoff elapsed) so the retry processor picks it
 * up deterministically — no reliance on wall-clock backoff windows.
 */
async function seedFailedReaction(
  db: AppDatabase,
  raw: Database.Database,
  args: { chatId: number; tempGuid: string; reaction: string; emoji?: string },
): Promise<void> {
  await insertOutgoingReaction(db, {
    tempGuid: args.tempGuid,
    chatId: args.chatId,
    chatGuid: 'c1',
    targetGuid: 'mt',
    reaction: args.reaction,
    emoji: args.emoji,
    selectedMessageText: 'hi',
    now: 1000,
  });
  raw
    .prepare("UPDATE messages SET send_state = 'error', error = 22 WHERE guid = ?")
    .run(args.tempGuid);
  raw
    .prepare('UPDATE outgoing_queue SET attempts = 1, next_retry_at = 0 WHERE temp_guid = ?')
    .run(args.tempGuid);
}

const queueCount = (raw: Database.Database): number =>
  (raw.prepare('SELECT COUNT(*) c FROM outgoing_queue').get() as { c: number }).c;

describe('runOutgoingQueue — emoji tapback resend', () => {
  it("re-POSTs an emoji tapback with reactionType 'emoji' + the glyph, then reconciles + dequeues", async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db);
    await seedFailedReaction(db, raw, { chatId, tempGuid: 'temp-emo', reaction: 'emoji', emoji: '🔥' });

    let body: Record<string, unknown> | undefined;
    const res = await runOutgoingQueue(
      db,
      fakeHttp(async (json) => {
        body = json as Record<string, unknown>;
        return { guid: 'real-emo', dateCreated: 2000 };
      }),
      2_000_000,
    );

    expect(res).toEqual({ eligible: 1, sent: 1 });
    // The retry re-POST carries the emoji reactionType AND the glyph (not a classic tapback).
    expect(body).toMatchObject({ messageGuid: 'mt', reactionType: 'emoji', reactionEmoji: '🔥' });
    // Reconciled to the real guid, glyph preserved, queue row cleared.
    expect(queueCount(raw)).toBe(0);
    const row = raw
      .prepare("SELECT send_state s, associated_message_emoji e FROM messages WHERE guid = 'real-emo'")
      .get() as { s: string; e: string };
    expect(row.s).toBe('sent');
    expect(row.e).toBe('🔥');
  });

  it("re-POSTs an emoji REMOVAL with reactionType '-emoji' + the glyph", async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db);
    await seedFailedReaction(db, raw, {
      chatId,
      tempGuid: 'temp-unemo',
      reaction: '-emoji',
      emoji: '🫡',
    });

    let body: Record<string, unknown> | undefined;
    await runOutgoingQueue(
      db,
      fakeHttp(async (json) => {
        body = json as Record<string, unknown>;
        return { guid: 'real-unemo', dateCreated: 2000 };
      }),
      2_000_000,
    );
    expect(body).toMatchObject({ reactionType: '-emoji', reactionEmoji: '🫡' });
  });

  it('a CLASSIC tapback retry carries NO reactionEmoji key (server rejects it)', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db);
    await seedFailedReaction(db, raw, { chatId, tempGuid: 'temp-love', reaction: 'love' });

    let body: Record<string, unknown> | undefined;
    await runOutgoingQueue(
      db,
      fakeHttp(async (json) => {
        body = json as Record<string, unknown>;
        return { guid: 'real-love', dateCreated: 2000 };
      }),
      2_000_000,
    );
    expect(body).toMatchObject({ reactionType: 'love' });
    expect(Object.keys(body!)).not.toContain('reactionEmoji');
  });
});
