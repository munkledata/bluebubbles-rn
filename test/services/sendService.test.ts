import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { Chat, Message } from '@core/models';
import { upsertChats, upsertHandles, upsertMessages } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { generateTempGuid, sendTextMessage } from '@/services/send/sendService';
import { createTestDb } from '../support/testDb';

/** Minimal fake HttpClient: only `post` is used (by sendText). */
function fakeHttp(impl: (json: unknown) => Promise<unknown>): HttpClient {
  return {
    post: (_path: string, _schema: unknown, opts: { json?: unknown }) => impl(opts?.json),
  } as unknown as HttpClient;
}

async function seedChat(db: AppDatabase, guid: string) {
  const handles = await upsertHandles(db, [{ address: 'craig@apple.com' }]);
  await upsertChats(
    db,
    [Chat.parse({ guid, participants: [{ address: 'craig@apple.com' }] })],
    handles,
  );
}

function countMessages(raw: Database.Database) {
  return (raw.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c;
}

describe('generateTempGuid', () => {
  it('matches temp-{8 alnum}', () => {
    for (let i = 0; i < 20; i++) expect(generateTempGuid()).toMatch(/^temp-[a-z0-9]{8}$/);
  });
});

describe('sendTextMessage', () => {
  it('optimistically inserts then promotes temp→real on success (one row, queue cleared)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await sendTextMessage(
      db,
      fakeHttp(async () => ({ guid: 'real-1', dateCreated: 1000, dateDelivered: null })),
      { chatGuid: 'c1', text: 'hello' },
    );

    expect(countMessages(raw)).toBe(1);
    const row = raw.prepare('SELECT guid, send_state s, is_from_me f FROM messages').get() as {
      guid: string;
      s: string;
      f: number;
    };
    expect(row.guid).toBe('real-1');
    expect(row.s).toBe('sent');
    expect(row.f).toBe(1);
    expect((raw.prepare('SELECT COUNT(*) c FROM outgoing_queue').get() as { c: number }).c).toBe(0);
  });

  it('persists a send-effect on the optimistic message + the queue payload', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    let queuedPayload = '';
    await sendTextMessage(
      db,
      fakeHttp(async () => {
        // Capture the optimistic state BEFORE reconciliation.
        const m = raw.prepare('SELECT expressive_send_style_id e FROM messages').get() as {
          e: string | null;
        };
        expect(m.e).toBe('com.apple.messages.effect.CKConfettiEffect');
        queuedPayload =
          (raw.prepare('SELECT payload p FROM outgoing_queue').get() as { p: string } | undefined)
            ?.p ?? '';
        return { guid: 'real-1', dateCreated: 1000, dateDelivered: null };
      }),
      { chatGuid: 'c1', text: 'party', effectId: 'com.apple.messages.effect.CKConfettiEffect' },
    );
    // The effect id is also sent to the server (in the queue payload).
    expect(queuedPayload).toContain('CKConfettiEffect');
  });

  it('does not duplicate when the socket echo lands FIRST (deletes temp)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    // The fake "server" upserts the real message (like DbEventSink) before responding.
    await sendTextMessage(
      db,
      fakeHttp(async () => {
        const handles = await upsertHandles(db, [{ address: 'craig@apple.com' }]);
        const map = new Map<string, number>();
        const chatId = (
          raw.prepare('SELECT id FROM chats WHERE guid=?').get('c1') as { id: number }
        ).id;
        map.set('craig@apple.com', handles.get('craig@apple.com')!);
        await upsertMessages(
          db,
          [Message.parse({ guid: 'real-2', text: 'hello', isFromMe: true, dateCreated: 1000 })],
          () => chatId,
          map,
        );
        return { guid: 'real-2', dateCreated: 1000, dateDelivered: 2000 };
      }),
      { chatGuid: 'c1', text: 'hello' },
    );

    expect(countMessages(raw)).toBe(1);
    expect((raw.prepare('SELECT guid FROM messages').get() as { guid: string }).guid).toBe(
      'real-2',
    );
  });

  it('does not duplicate when the echo arrives AFTER promotion (conflict update)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await sendTextMessage(
      db,
      fakeHttp(async () => ({ guid: 'real-3', dateCreated: 1000, dateDelivered: null })),
      {
        chatGuid: 'c1',
        text: 'hi',
      },
    );
    // Now the socket echo upserts the same real guid.
    const chatId = (raw.prepare('SELECT id FROM chats WHERE guid=?').get('c1') as { id: number })
      .id;
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'real-3',
          text: 'hi',
          isFromMe: true,
          dateCreated: 1000,
          dateDelivered: 5000,
        }),
      ],
      () => chatId,
      new Map(),
    );
    expect(countMessages(raw)).toBe(1);
  });

  it('marks the message errored on failure (one row, queue attempt bumped)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await sendTextMessage(
      db,
      fakeHttp(async () => {
        throw new ApiError('unauthorized', 'nope', 401);
      }),
      { chatGuid: 'c1', text: 'fails' },
    );
    expect(countMessages(raw)).toBe(1);
    const row = raw.prepare('SELECT send_state s, error e FROM messages').get() as {
      s: string;
      e: number;
    };
    expect(row.s).toBe('error');
    expect(row.e).toBe(401);
    expect(
      (raw.prepare('SELECT attempts FROM outgoing_queue').get() as { attempts: number }).attempts,
    ).toBe(1);
  });

  it('throws for an unknown chat', async () => {
    const { db } = await createTestDb();
    await expect(
      sendTextMessage(
        db,
        fakeHttp(async () => ({})),
        { chatGuid: 'nope', text: 'x' },
      ),
    ).rejects.toThrow(/unknown chat/);
  });
});
