import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { Chat, Message } from '@core/models';
import { upsertChats, upsertHandles, upsertMessages } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { sendImageMessage } from '@/services/send/sendAttachmentService';
import { createTestDb } from '../support/testDb';

function fakeHttp(impl: () => Promise<unknown>): HttpClient {
  return { post: () => impl() } as unknown as HttpClient;
}

const IMG = {
  uri: 'file:///photo.jpg',
  name: 'photo.jpg',
  mimeType: 'image/jpeg',
  size: 1000,
  width: 800,
  height: 600,
};

async function seedChat(db: AppDatabase, guid: string) {
  const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
  await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], handles);
}
const one = (raw: Database.Database, sql: string) =>
  raw.prepare(sql).get() as Record<string, unknown>;

/**
 * Simulate the socket `new-message` echo: the server re-broadcasts the just-sent message
 * by its REAL guid, carrying the real attachment guid (which the HTTP attachment ack does
 * NOT include — the Gator ack is `{ guid }`, the message guid only). DbEventSink routes
 * this through upsertMessages → upsertAttachments, which reconciles the optimistic temp
 * attachment in place (preserving local_path).
 */
async function echoMessageWithAttachment(
  db: AppDatabase,
  raw: Database.Database,
  msgGuid: string,
  attGuid: string,
) {
  const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
  const chatId = (raw.prepare('SELECT id FROM chats WHERE guid=?').get('c1') as { id: number }).id;
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: msgGuid,
        isFromMe: true,
        dateCreated: 1000,
        hasAttachments: true,
        attachments: [{ guid: attGuid, mimeType: 'image/jpeg' }],
      }),
    ],
    () => chatId,
    handles,
  );
}

describe('sendImageMessage', () => {
  it('promotes the message on the ack; the attachment keeps its local guid+path until the echo', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    // Gator's attachment-send ack carries ONLY the message guid (no attachment guid).
    await sendImageMessage(
      db,
      fakeHttp(async () => ({ guid: 'real-msg', viaPrivateApi: true })),
      { chatGuid: 'c1', image: IMG },
    );

    expect((one(raw, 'SELECT COUNT(*) c FROM messages') as { c: number }).c).toBe(1);
    const msg = one(raw, 'SELECT guid, send_state s, has_attachments h FROM messages');
    expect(msg.guid).toBe('real-msg'); // promoted via the ack guid
    expect(msg.s).toBe('sent');
    expect(msg.h).toBe(1);
    // The attachment is NOT promoted by the ack — it keeps its optimistic temp guid + the
    // on-disk local path so it renders immediately.
    const att = one(raw, 'SELECT guid, local_path lp FROM attachments');
    expect(att.guid as string).toMatch(/-att$/);
    expect(att.lp).toBe('file:///photo.jpg');
    expect((one(raw, 'SELECT COUNT(*) c FROM outgoing_queue') as { c: number }).c).toBe(0);
  });

  it('reconciles the temp attachment to the real guid (preserving local_path) on the socket echo', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await sendImageMessage(
      db,
      fakeHttp(async () => ({ guid: 'real-msg', viaPrivateApi: true })),
      { chatGuid: 'c1', image: IMG },
    );

    await echoMessageWithAttachment(db, raw, 'real-msg', 'real-att');

    // One attachment, now under the REAL guid, with the local path carried over → no
    // duplicate bubble, no re-download.
    expect((one(raw, 'SELECT COUNT(*) c FROM attachments') as { c: number }).c).toBe(1);
    const att = one(raw, 'SELECT guid, local_path lp FROM attachments');
    expect(att.guid).toBe('real-att');
    expect(att.lp).toBe('file:///photo.jpg');
  });

  it('does not duplicate the attachment when the echo real guid already exists', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await sendImageMessage(
      db,
      fakeHttp(async () => {
        // A prior echo already inserted the real attachment guid (message_id nullable).
        raw
          .prepare("INSERT INTO attachments (guid, mime_type) VALUES ('real-att2', 'image/jpeg')")
          .run();
        return { guid: 'real-msg2', viaPrivateApi: true };
      }),
      { chatGuid: 'c1', image: IMG },
    );

    await echoMessageWithAttachment(db, raw, 'real-msg2', 'real-att2');
    // The temp row is dropped (the real guid pre-existed) → exactly one 'real-att2'.
    expect(
      (one(raw, "SELECT COUNT(*) c FROM attachments WHERE guid='real-att2'") as { c: number }).c,
    ).toBe(1);
  });

  it('marks the message errored but keeps the local attachment so it still renders', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await sendImageMessage(
      db,
      fakeHttp(async () => {
        throw new ApiError('server_error', 'boom', 500);
      }),
      { chatGuid: 'c1', image: IMG },
    );
    const msg = one(raw, 'SELECT send_state s, error e FROM messages');
    expect(msg.s).toBe('error');
    expect(msg.e).toBe(500);
    expect((one(raw, 'SELECT local_path lp FROM attachments') as { lp: string }).lp).toBe(
      'file:///photo.jpg',
    );
  });

  it('multi-select: N picked images → N messages + N attachments + N queue rows', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const fail = fakeHttp(async () => {
      throw new ApiError('server_error', 'boom', 500);
    });
    // Mirrors sendImages(): one optimistic sendImageMessage per picked asset.
    for (let i = 0; i < 3; i++) {
      await sendImageMessage(db, fail, { chatGuid: 'c1', image: { ...IMG, name: `p${i}.jpg` } });
    }
    expect((one(raw, 'SELECT COUNT(*) c FROM messages') as { c: number }).c).toBe(3);
    expect((one(raw, 'SELECT COUNT(*) c FROM attachments') as { c: number }).c).toBe(3);
    expect((one(raw, 'SELECT COUNT(*) c FROM outgoing_queue') as { c: number }).c).toBe(3);
  });
});
