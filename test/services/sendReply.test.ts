import type Database from 'better-sqlite3';
import type { HttpClient } from '@core/api/http';
import { Chat, Message } from '@core/models';
import { upsertChats, upsertHandles, upsertMessages } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { sendTextMessage } from '@/services/send/sendService';
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
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: 'orig',
        text: 'original',
        dateCreated: 100,
        handle: { address: 'a@x.com' },
      }),
    ],
    () => map.get('c1')!,
    hm,
  );
}

describe('reply send (sendTextMessage with a reply target)', () => {
  it('persists thread_originator_guid locally and posts selectedMessageGuid', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    let body: Record<string, unknown> | undefined;
    await sendTextMessage(
      db,
      fakeHttp(async (json) => {
        body = json as Record<string, unknown>;
        return { guid: 'real-reply', dateCreated: 200, dateDelivered: 201 };
      }),
      { chatGuid: 'c1', text: 'Yes!', selectedMessageGuid: 'orig' },
    );

    expect(body).toMatchObject({ selectedMessageGuid: 'orig', text: 'Yes!' });
    const row = raw
      .prepare("SELECT thread_originator_guid t FROM messages WHERE guid='real-reply'")
      .get() as {
      t: string | null;
    };
    expect(row.t).toBe('orig');
  });

  it('a plain (non-reply) send leaves thread_originator_guid null', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    await sendTextMessage(
      db,
      fakeHttp(async () => ({ guid: 'real-plain', dateCreated: 200, dateDelivered: 201 })),
      { chatGuid: 'c1', text: 'hello' },
    );
    const row = raw
      .prepare("SELECT thread_originator_guid t FROM messages WHERE guid='real-plain'")
      .get() as {
      t: string | null;
    };
    expect(row.t).toBeNull();
  });
});
