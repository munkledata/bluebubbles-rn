/**
 * Emoji-tapback send path: the wire body carries reactionType 'emoji'/'-emoji' PLUS
 * reactionEmoji (the glyph), while classic tapbacks must NOT carry the reactionEmoji key
 * at all — the server's schema rejects it on classic types. The optimistic row persists
 * the glyph so the cluster badge renders it before the echo.
 */
import type Database from 'better-sqlite3';
import type { HttpClient } from '@core/api/http';
import { Chat, Message } from '@core/models';
import { listReactionsByMessageGuids, upsertChats, upsertHandles, upsertMessages } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { sendReactionMessage } from '@/services/send/sendReactionService';
import { createTestDb } from '../support/testDb';

function fakeHttp(impl: (json?: unknown) => Promise<unknown>): HttpClient {
  return {
    post: (_p: string, _s: unknown, opts?: { json?: unknown }) => impl(opts?.json),
  } as unknown as HttpClient;
}

async function seed(db: AppDatabase) {
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
}

const one = (raw: Database.Database, sql: string) =>
  raw.prepare(sql).get() as Record<string, unknown>;

describe('sendReactionMessage — emoji tapbacks', () => {
  it("posts reactionType 'emoji' + reactionEmoji and persists the glyph optimistically", async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    let body: Record<string, unknown> | undefined;
    await sendReactionMessage(
      db,
      fakeHttp(async (json) => {
        body = json as Record<string, unknown>;
        return { guid: 'real-react', dateCreated: 1000 };
      }),
      { chatGuid: 'c1', targetGuid: 'mt', reaction: 'emoji', emoji: '🔥', selectedMessageText: 'hi' },
    );

    expect(body).toMatchObject({ messageGuid: 'mt', reactionType: 'emoji', reactionEmoji: '🔥' });
    const row = one(raw, "SELECT associated_message_emoji AS e FROM messages WHERE guid = 'real-react'");
    expect(row.e).toBe('🔥');
    // And the reactions repo renders it as an own emoji badge.
    const rows = (await listReactionsByMessageGuids(db, ['mt'])).get('mt') ?? [];
    expect(rows[0]).toMatchObject({ baseType: 'emoji', emoji: '🔥', isFromMe: 1 });
  });

  it("posts '-emoji' + the glyph for a removal", async () => {
    const { db } = await createTestDb();
    await seed(db);
    let body: Record<string, unknown> | undefined;
    await sendReactionMessage(
      db,
      fakeHttp(async (json) => {
        body = json as Record<string, unknown>;
        return { guid: 'real-unreact', dateCreated: 1000 };
      }),
      { chatGuid: 'c1', targetGuid: 'mt', reaction: '-emoji', emoji: '🔥' },
    );
    expect(body).toMatchObject({ reactionType: '-emoji', reactionEmoji: '🔥' });
  });

  it('a classic tapback body has NO reactionEmoji key (server rejects it)', async () => {
    const { db } = await createTestDb();
    await seed(db);
    let body: Record<string, unknown> | undefined;
    await sendReactionMessage(
      db,
      fakeHttp(async (json) => {
        body = json as Record<string, unknown>;
        return { guid: 'real-love', dateCreated: 1000 };
      }),
      { chatGuid: 'c1', targetGuid: 'mt', reaction: 'love' },
    );
    expect(body).toMatchObject({ reactionType: 'love' });
    expect(Object.keys(body!)).not.toContain('reactionEmoji');
  });

  it('the queued retry payload carries the glyph (crash-recovery resend stays an emoji tapback)', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    // Fail the live send so the queue row survives with attempts>=1.
    await sendReactionMessage(
      db,
      fakeHttp(async () => {
        throw new Error('network down');
      }),
      { chatGuid: 'c1', targetGuid: 'mt', reaction: 'emoji', emoji: '🫡' },
    );
    const q = one(raw, "SELECT payload FROM outgoing_queue WHERE kind = 'reaction'");
    expect(JSON.parse(q.payload as string)).toMatchObject({ reaction: 'emoji', emoji: '🫡' });
  });
});
