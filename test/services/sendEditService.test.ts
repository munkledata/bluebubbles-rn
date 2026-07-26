import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { Chat, Message } from '@core/models';
import { upsertChats, upsertHandles, upsertMessages } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { sendEdit, sendUnsend } from '@/services/send/sendEditService';
import { createTestDb } from '../support/testDb';

const okHttp = { post: async () => ({ guid: 'm1' }) } as unknown as HttpClient;
const failHttp = {
  post: async () => {
    throw new ApiError('no_connection', 'offline', 0);
  },
} as unknown as HttpClient;

/** Capture the JSON body so we can assert the server-required wire shape (F-4/F-5). */
function capturingHttp(impl: () => Promise<unknown>): { http: HttpClient; body(): unknown } {
  let captured: unknown;
  const http = {
    post: (_p: string, _s: unknown, opts?: { json?: unknown }) => {
      captured = opts?.json;
      return impl();
    },
  } as unknown as HttpClient;
  return { http, body: () => captured };
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
  await upsertMessages(
    db,
    [Message.parse({ guid: 'm1', text: 'original', isFromMe: true, dateCreated: 100 })],
    () => map.get('c1')!,
    hm,
  );
}

describe('sendEdit / sendUnsend', () => {
  it('edit: applies the new text on success', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    const r = await sendEdit(db, okHttp, { messageGuid: 'm1', newText: 'edited!' }, 5000);
    expect(r.ok).toBe(true);
    const row = one(raw, "SELECT text, date_edited e FROM messages WHERE guid='m1'");
    expect(row.text).toBe('edited!');
    expect(row.e).toBe(5000);
  });

  it('edit: posts the server-required body {chatGuid, editedText, backwardsCompatText} (F-4)', async () => {
    const { db } = await createTestDb();
    await seed(db); // m1 lives in chat c1
    const cap = capturingHttp(async () => ({ guid: 'm1' }));
    await sendEdit(db, cap.http, { messageGuid: 'm1', newText: 'edited!' }, 5000);
    expect(cap.body()).toMatchObject({
      chatGuid: 'c1', // resolved from the message's DB row
      editedText: 'edited!',
      partIndex: 0,
    });
    expect((cap.body() as Record<string, unknown>).backwardsCompatText).toContain('edited!');
  });

  it('unsend: posts the server-required body {chatGuid} (F-5)', async () => {
    const { db } = await createTestDb();
    await seed(db);
    const cap = capturingHttp(async () => ({ unsent: true }));
    await sendUnsend(db, cap.http, { messageGuid: 'm1' }, 7000);
    expect(cap.body()).toMatchObject({ chatGuid: 'c1', partIndex: 0 });
  });

  it('edit: reverts the text on failure', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    const r = await sendEdit(db, failHttp, { messageGuid: 'm1', newText: 'edited!' }, 5000);
    expect(r.ok).toBe(false);
    expect((one(raw, "SELECT text FROM messages WHERE guid='m1'") as { text: string }).text).toBe(
      'original',
    );
  });

  it('unsend: sets dateRetracted on success, clears it on failure', async () => {
    const a = await createTestDb();
    await seed(a.db);
    expect((await sendUnsend(a.db, okHttp, { messageGuid: 'm1' }, 7000)).ok).toBe(true);
    expect(
      (one(a.raw, "SELECT date_retracted d FROM messages WHERE guid='m1'") as { d: number | null })
        .d,
    ).toBe(7000);

    const b = await createTestDb();
    await seed(b.db);
    expect((await sendUnsend(b.db, failHttp, { messageGuid: 'm1' }, 7000)).ok).toBe(false);
    expect(
      (one(b.raw, "SELECT date_retracted d FROM messages WHERE guid='m1'") as { d: number | null })
        .d,
    ).toBeNull();
  });

  // The revert is a COMPARE-AND-SET on the marker our own optimistic write left behind. A failed
  // POST does NOT prove the server didn't apply the change — a lost response still emits an echo,
  // and that echo lands first. Reverting blindly on top of it is a lost update: for an edit the
  // message reads the old wording to you and the new one to everyone else, permanently; for an
  // unsend it puts content the user revoked from everyone back on their own screen.
  it('edit: does NOT revert over an echo that landed while the POST was failing', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    const http = {
      post: async () => {
        // The server applied the edit and echoed it; the echo wins the race, then our POST throws.
        await upsertMessages(
          db,
          [
            Message.parse({
              guid: 'm1',
              text: 'edited!',
              isFromMe: true,
              dateCreated: 100,
              dateEdited: 9999, // the SERVER's stamp — never equal to our optimistic `now`
            }),
          ],
          () => 1,
          new Map(),
        );
        throw new ApiError('no_connection', 'offline', 0);
      },
    } as unknown as HttpClient;

    const r = await sendEdit(db, http, { messageGuid: 'm1', newText: 'edited!' }, 5000);
    expect(r.ok).toBe(false);
    const row = one(raw, "SELECT text, date_edited d FROM messages WHERE guid='m1'") as {
      text: string;
      d: number | null;
    };
    expect(row.text).toBe('edited!'); // the echo's value survives — NOT reverted to 'original'
    expect(row.d).toBe(9999);
  });

  it('unsend: does NOT clear a retraction the server actually stamped', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    const http = {
      post: async () => {
        // The server retracted it and echoed with its OWN timestamp; then our POST throws.
        await upsertMessages(
          db,
          [
            Message.parse({
              guid: 'm1',
              text: 'original',
              isFromMe: true,
              dateCreated: 100,
              dateRetracted: 8888,
            }),
          ],
          () => 1,
          new Map(),
        );
        throw new ApiError('no_connection', 'offline', 0);
      },
    } as unknown as HttpClient;

    expect((await sendUnsend(db, http, { messageGuid: 'm1' }, 7000)).ok).toBe(false);
    expect(
      (one(raw, "SELECT date_retracted d FROM messages WHERE guid='m1'") as { d: number | null }).d,
    ).toBe(8888); // still retracted — the revoked content is not put back on screen
  });
});
