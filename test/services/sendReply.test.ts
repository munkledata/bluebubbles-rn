import type { HttpClient } from '@core/api/http';
import { Chat, Message } from '@core/models';
import { upsertChats, upsertHandles, upsertMessages } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { sendTextMessage } from '@/services/send/sendService';
import { createTestDb } from '../support/testDb';

function fakeHttp(impl: (json?: unknown) => Promise<unknown>): HttpClient {
  let http!: HttpClient;
  http = {
    get: async () => ({
      private_api: true,
      supports_message_part_topology: true,
    }),
    post: (_p: string, _s: unknown, opts?: { json?: unknown }) => impl(opts?.json),
    pinTransport: () => http,
    isTransportCurrent: () => true,
    assertTransportCurrent: () => undefined,
  } as unknown as HttpClient;
  return http;
}

async function seed(db: AppDatabase, targetGuid = 'orig') {
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
        guid: targetGuid,
        text: 'original',
        dateCreated: 100,
        handle: { address: 'a@x.com' },
        messagePartTopology: {
          complete: true,
          originalPartIndexes: [2, 3],
          currentParts: [
            { index: 2, kind: 'text' },
            { index: 3, kind: 'text' },
          ],
          attachmentOwnership: [],
        },
      }),
    ],
    () => map.get('c1')!,
    hm,
  );
}

describe('reply send (sendTextMessage with a reply target)', () => {
  it('rejects a stale targeted RCS caller before queue admission or POST', async () => {
    const { db, raw } = await createTestDb();
    const onQueued = jest.fn();
    let posts = 0;

    await expect(
      sendTextMessage(
        db,
        fakeHttp(async () => {
          posts += 1;
          return { guid: 'must-not-send' };
        }),
        {
          chatGuid: 'RCS;-;thread-1',
          text: 'must stay local',
          selectedMessageGuid: 'rcs-target',
          partIndex: 0,
        },
        1_000,
        onQueued,
      ),
    ).rejects.toThrow('This server cannot send an RCS threaded reply.');

    expect(posts).toBe(0);
    expect(onQueued).not.toHaveBeenCalled();
    expect(raw.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 0 });
  });

  it('rejects an iMessage reply before queue admission or POST', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    const onQueued = jest.fn();
    let posts = 0;

    await expect(
      sendTextMessage(
        db,
        fakeHttp(async () => {
          posts += 1;
          return { guid: 'must-not-send' };
        }),
        { chatGuid: 'c1', text: 'must stay local', selectedMessageGuid: 'orig', partIndex: 2 },
        1_000,
        onQueued,
      ),
    ).rejects.toThrow('Private API message features were retired in this release.');

    expect(posts).toBe(0);
    expect(onQueued).not.toHaveBeenCalled();
    expect(
      raw.prepare("SELECT COUNT(*) AS count FROM messages WHERE guid LIKE 'temp-%'").get(),
    ).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 0 });
  });

  it('a plain (non-reply) send leaves thread_originator_guid null', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    let body: Record<string, unknown> | undefined;
    await sendTextMessage(
      db,
      fakeHttp(async (json) => {
        body = json as Record<string, unknown>;
        return { guid: 'real-plain', dateCreated: 200, dateDelivered: 201 };
      }),
      { chatGuid: 'c1', text: 'hello' },
    );
    expect(body).not.toHaveProperty('partIndex');
    const row = raw
      .prepare("SELECT thread_originator_guid t FROM messages WHERE guid='real-plain'")
      .get() as {
      t: string | null;
    };
    expect(row.t).toBeNull();
  });

  it('rejects a reply GUID without an explicit part before DB or network work', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    let posts = 0;

    await expect(
      sendTextMessage(
        db,
        fakeHttp(async () => {
          posts += 1;
          return { guid: 'must-not-send' };
        }),
        { chatGuid: 'c1', text: 'ambiguous reply', selectedMessageGuid: 'orig' },
      ),
    ).rejects.toThrow('exact target part');
    expect(posts).toBe(0);
    expect(
      raw.prepare("SELECT COUNT(*) AS count FROM messages WHERE guid LIKE 'temp-%'").get(),
    ).toEqual({ count: 0 });
  });
});
