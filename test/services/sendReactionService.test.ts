import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { Chat } from '@core/models';
import {
  listReactionsByMessageGuids,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { Message } from '@core/models';
import type { AppDatabase } from '@db/types';
import { sendReactionMessage } from '@/services/send/sendReactionService';
import { createTestDb } from '../support/testDb';

function fakeHttp(impl: (json?: unknown) => Promise<unknown>): HttpClient {
  return {
    post: (_p: string, _s: unknown, opts?: { json?: unknown }) => impl(opts?.json),
  } as unknown as HttpClient;
}
const one = (raw: Database.Database, sql: string) =>
  raw.prepare(sql).get() as Record<string, unknown>;

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

describe('sendReactionMessage', () => {
  it('optimistically inserts a reaction + reconciles, posting the right body', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    let body: Record<string, unknown> | undefined;
    await sendReactionMessage(
      db,
      fakeHttp(async (json) => {
        body = json as Record<string, unknown>;
        return { guid: 'real-react', dateCreated: 1000 };
      }),
      { chatGuid: 'c1', targetGuid: 'mt', reaction: 'love', selectedMessageText: 'hi' },
    );

    // Server contract: { chatGuid, messageGuid, reactionType } (F-2).
    expect(body).toMatchObject({ messageGuid: 'mt', reactionType: 'love', partIndex: 0 });
    const row = one(
      raw,
      "SELECT guid, send_state s, associated_message_type t FROM messages WHERE associated_message_guid='mt'",
    );
    expect(row.guid).toBe('real-react'); // promoted
    expect(row.s).toBe('sent');
    expect(row.t).toBe('love');
    expect((one(raw, 'SELECT COUNT(*) c FROM outgoing_queue') as { c: number }).c).toBe(0);
    expect((await listReactionsByMessageGuids(db, ['mt'])).get('mt')).toHaveLength(1);
  });

  it('toggles off when the same type is sent then removed', async () => {
    const { db } = await createTestDb();
    await seed(db);
    const ok = fakeHttp(async () => ({ guid: `r${Math.random()}`, dateCreated: 1 }));
    await sendReactionMessage(db, ok, { chatGuid: 'c1', targetGuid: 'mt', reaction: 'love' }, 1000);
    await sendReactionMessage(
      db,
      ok,
      { chatGuid: 'c1', targetGuid: 'mt', reaction: '-love' },
      2000,
    );
    expect((await listReactionsByMessageGuids(db, ['mt'])).get('mt') ?? []).toHaveLength(0);
  });

  it('marks the reaction errored on failure', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    await sendReactionMessage(
      db,
      fakeHttp(async () => {
        throw new ApiError('server_error', 'boom', 500);
      }),
      { chatGuid: 'c1', targetGuid: 'mt', reaction: 'like' },
    );
    expect(
      (
        one(
          raw,
          'SELECT send_state s, error e FROM messages WHERE associated_message_type IS NOT NULL',
        ) as { s: string; e: number }
      ).s,
    ).toBe('error');
  });

  it('does not reorder the inbox (latest_message_date unchanged)', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    const before = (
      one(raw, "SELECT latest_message_date d FROM chats WHERE guid='c1'") as { d: number | null }
    ).d;
    await sendReactionMessage(
      db,
      fakeHttp(async () => ({ guid: 'r', dateCreated: 9999 })),
      { chatGuid: 'c1', targetGuid: 'mt', reaction: 'love' },
    );
    const after = (
      one(raw, "SELECT latest_message_date d FROM chats WHERE guid='c1'") as { d: number | null }
    ).d;
    expect(after).toBe(before);
  });
});
