import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { Chat } from '@core/models';
import { upsertChats, upsertHandles } from '@db/repositories';
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

describe('sendImageMessage', () => {
  it('optimistically inserts an image message + attachment + queue, then reconciles', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await sendImageMessage(
      db,
      fakeHttp(async () => ({
        guid: 'real-msg',
        dateCreated: 1000,
        dateDelivered: null,
        attachments: [{ guid: 'real-att' }],
      })),
      { chatGuid: 'c1', image: IMG },
    );

    expect((one(raw, 'SELECT COUNT(*) c FROM messages') as { c: number }).c).toBe(1);
    const msg = one(raw, 'SELECT guid, send_state s, has_attachments h FROM messages');
    expect(msg.guid).toBe('real-msg');
    expect(msg.s).toBe('sent');
    expect(msg.h).toBe(1);
    const att = one(raw, 'SELECT guid, local_path lp FROM attachments');
    expect(att.guid).toBe('real-att'); // promoted
    expect(att.lp).toBe('file:///photo.jpg'); // local file retained → renders without re-download
    expect((one(raw, 'SELECT COUNT(*) c FROM outgoing_queue') as { c: number }).c).toBe(0);
  });

  it('does not duplicate the attachment when the echo lands first', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await sendImageMessage(
      db,
      fakeHttp(async () => {
        // Simulate DbEventSink upserting the real attachment guid before responding
        // (message_id is nullable; the dedup is by attachment guid).
        raw
          .prepare("INSERT INTO attachments (guid, mime_type) VALUES ('real-att2', 'image/jpeg')")
          .run();
        return {
          guid: 'real-msg2',
          dateCreated: 1000,
          dateDelivered: 2000,
          attachments: [{ guid: 'real-att2' }],
        };
      }),
      { chatGuid: 'c1', image: IMG },
    );
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
