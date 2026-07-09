import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { SendAck } from '@core/api/endpoints/messages';
import type { HttpClient } from '@core/api/http';
import { Chat, Message } from '@core/models';
import {
  reconcileEchoByContent,
  reconcileOutgoingAttachmentByContent,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import {
  sendImageMessage,
  type AttachmentUploader,
} from '@/services/send/sendAttachmentService';
import { createTestDb } from '../support/testDb';

const dummyHttp = {} as unknown as HttpClient;

/**
 * Stub uploader: production streams the file via a native upload (`expo-file-system`), which isn't
 * available in Node, so tests inject a fake that returns/throws the server's ack and captures the
 * args the service passed it.
 */
function fakeUploader(impl: (args: Parameters<AttachmentUploader>[0]) => Promise<SendAck>): {
  upload: AttachmentUploader;
  captured?: Parameters<AttachmentUploader>[0];
} {
  const holder: { upload: AttachmentUploader; captured?: Parameters<AttachmentUploader>[0] } = {
    upload: async (args) => {
      holder.captured = args;
      return impl(args);
    },
  };
  return holder;
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
    const up = fakeUploader(async () => ({ guid: 'real-msg', viaPrivateApi: true }));
    await sendImageMessage(db, dummyHttp, { chatGuid: 'c1', image: IMG }, up.upload);

    // The service hands the picked file's fields to the uploader (production streams them natively).
    expect(up.captured).toMatchObject({
      chatGuid: 'c1',
      name: 'photo.jpg',
      uri: 'file:///photo.jpg',
      mimeType: 'image/jpeg',
    });
    expect(up.captured?.tempGuid).toBeTruthy();
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
    const up = fakeUploader(async () => ({ guid: 'real-msg', viaPrivateApi: true }));
    await sendImageMessage(db, dummyHttp, { chatGuid: 'c1', image: IMG }, up.upload);

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
    const up = fakeUploader(async () => {
      // A prior echo already inserted the real attachment guid (message_id nullable).
      raw
        .prepare("INSERT INTO attachments (guid, mime_type) VALUES ('real-att2', 'image/jpeg')")
        .run();
      return { guid: 'real-msg2', viaPrivateApi: true };
    });
    await sendImageMessage(db, dummyHttp, { chatGuid: 'c1', image: IMG }, up.upload);

    await echoMessageWithAttachment(db, raw, 'real-msg2', 'real-att2');
    // The temp row is dropped (the real guid pre-existed) → exactly one 'real-att2'.
    expect(
      (one(raw, "SELECT COUNT(*) c FROM attachments WHERE guid='real-att2'") as { c: number }).c,
    ).toBe(1);
  });

  it('RCS: ack echoes back the tempGuid → keeps the optimistic image, then the fanout reconciles it', async () => {
    // An RCS (bridge) send acks with `guid === tempGuid` (a correlation token, NOT a real message
    // guid — the real `rcs-<id>` only arrives on the live `new-message` fanout). This must NOT
    // delete the optimistic row (which would lose the picture's on-disk local_path → reload button).
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const up = fakeUploader(async (args) => ({ guid: args.tempGuid, viaPrivateApi: false }));
    await sendImageMessage(db, dummyHttp, { chatGuid: 'c1', image: IMG }, up.upload, 1000);
    const tempGuid = up.captured!.tempGuid;

    // The image survives: one message, flipped to 'sent', still its temp guid, local_path intact.
    expect((one(raw, 'SELECT COUNT(*) c FROM messages') as { c: number }).c).toBe(1);
    const sent = one(raw, 'SELECT guid, send_state s FROM messages');
    expect(sent.guid).toBe(tempGuid);
    expect(sent.s).toBe('sent');
    expect((one(raw, 'SELECT local_path lp FROM attachments') as { lp: string }).lp).toBe(
      'file:///photo.jpg',
    );
    // Queue row dropped (no spurious retry), exactly like the guid-absent AppleScript path.
    expect((one(raw, 'SELECT COUNT(*) c FROM outgoing_queue') as { c: number }).c).toBe(0);

    // Live fanout (DbEventSink path): the real message + attachment arrive under real guids.
    // reconcileEchoByContent promotes the optimistic row in place; upsertMessages/Attachments then
    // reconcile the temp attachment → real guid, preserving local_path (no duplicate, no download).
    const chatId = (raw.prepare('SELECT id FROM chats WHERE guid=?').get('c1') as { id: number }).id;
    const echo = Message.parse({
      guid: 'rcs-99',
      isFromMe: true,
      dateCreated: 1000,
      hasAttachments: true,
      attachments: [{ guid: 'rcs-media-1', mimeType: 'image/jpeg' }],
    });
    await reconcileEchoByContent(db, echo, chatId);
    const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertMessages(db, [echo], () => chatId, handles);

    expect((one(raw, 'SELECT COUNT(*) c FROM messages') as { c: number }).c).toBe(1);
    expect((one(raw, 'SELECT guid FROM messages') as { guid: string }).guid).toBe('rcs-99');
    expect((one(raw, 'SELECT COUNT(*) c FROM attachments') as { c: number }).c).toBe(1);
    const att = one(raw, 'SELECT guid, local_path lp FROM attachments');
    expect(att.guid).toBe('rcs-media-1');
    expect(att.lp).toBe('file:///photo.jpg');
  });

  it('RCS sync-first: the real rcs-<id> materialized by SYNC (not the live echo) still keeps the local image', async () => {
    // The disappearing-picture bug: RCS has no server rowid, so the real message is often first
    // written by a SYNC path (thread re-open / pull-to-refresh / reconnect), which does NOT call
    // reconcileEchoByContent. Without the sync-safe reconcile, upsertMessages inserts a SEPARATE
    // rcs-<id> row and upsertAttachments (keyed by message_id) can't find the temp -att → the server
    // attachment lands with local_path NULL (a second, image-less bubble). This reproduces the sync
    // ordering: reconcileOutgoingAttachmentByContent BEFORE upsertMessages (exactly the engine.ts wiring).
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const up = fakeUploader(async (args) => ({ guid: args.tempGuid, viaPrivateApi: false }));
    await sendImageMessage(db, dummyHttp, { chatGuid: 'c1', image: IMG }, up.upload, 1000);
    const tempGuid = up.captured!.tempGuid;

    const chatId = (raw.prepare('SELECT id FROM chats WHERE guid=?').get('c1') as { id: number }).id;
    const echo = Message.parse({
      guid: 'rcs-99',
      isFromMe: true,
      dateCreated: 1000,
      hasAttachments: true,
      attachments: [{ guid: 'rcs-media-1', mimeType: 'image/jpeg' }],
    });
    await reconcileOutgoingAttachmentByContent(db, echo, chatId);
    const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertMessages(db, [echo], () => chatId, handles);

    // Exactly one message — the temp row promoted IN PLACE, not duplicated — under the real guid,
    // and exactly one attachment, under the real guid, with the on-disk image preserved.
    expect((one(raw, 'SELECT COUNT(*) c FROM messages') as { c: number }).c).toBe(1);
    expect((one(raw, 'SELECT guid FROM messages') as { guid: string }).guid).toBe('rcs-99');
    expect(tempGuid).not.toBe('rcs-99');
    expect((one(raw, 'SELECT COUNT(*) c FROM attachments') as { c: number }).c).toBe(1);
    const att = one(raw, 'SELECT guid, local_path lp FROM attachments');
    expect(att.guid).toBe('rcs-media-1');
    expect(att.lp).toBe('file:///photo.jpg');
  });

  it('sync reconcile does NOT hijack a fresh optimistic send with an OLD identical re-synced picture', async () => {
    // Sync-safety: a history backfill surfacing an OLD identical picture (same null text) must not
    // claim the fresh pending optimistic row — the ±5min window rejects it. This is exactly why the
    // sync path needs a NARROW helper rather than reconcileEchoByContent.
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const up = fakeUploader(async (args) => ({ guid: args.tempGuid, viaPrivateApi: false }));
    // Fresh send "now" = 10_000_000.
    await sendImageMessage(db, dummyHttp, { chatGuid: 'c1', image: IMG }, up.upload, 10_000_000);
    const tempGuid = up.captured!.tempGuid;

    const chatId = (raw.prepare('SELECT id FROM chats WHERE guid=?').get('c1') as { id: number }).id;
    const old = Message.parse({
      guid: 'rcs-old',
      isFromMe: true,
      dateCreated: 10_000_000 - 7 * 24 * 3600_000, // a week earlier — outside the correlation window
      hasAttachments: true,
      attachments: [{ guid: 'rcs-media-old', mimeType: 'image/jpeg' }],
    });
    await reconcileOutgoingAttachmentByContent(db, old, chatId);
    const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertMessages(db, [old], () => chatId, handles);

    // The fresh temp row is untouched (still its temp guid); the old picture inserts as its OWN row.
    expect(raw.prepare('SELECT guid FROM messages WHERE guid=?').get(tempGuid)).toBeTruthy();
    expect(raw.prepare("SELECT guid FROM messages WHERE guid='rcs-old'").get()).toBeTruthy();
    expect((one(raw, 'SELECT COUNT(*) c FROM messages') as { c: number }).c).toBe(2);
  });

  it('marks the message errored but keeps the local attachment so it still renders', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const up = fakeUploader(async () => {
      throw new ApiError('server_error', 'boom', 500);
    });
    await sendImageMessage(db, dummyHttp, { chatGuid: 'c1', image: IMG }, up.upload);
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
    const fail = fakeUploader(async () => {
      throw new ApiError('server_error', 'boom', 500);
    });
    // Mirrors sendImages(): one optimistic sendImageMessage per picked asset.
    for (let i = 0; i < 3; i++) {
      await sendImageMessage(
        db,
        dummyHttp,
        { chatGuid: 'c1', image: { ...IMG, name: `p${i}.jpg` } },
        fail.upload,
      );
    }
    expect((one(raw, 'SELECT COUNT(*) c FROM messages') as { c: number }).c).toBe(3);
    expect((one(raw, 'SELECT COUNT(*) c FROM attachments') as { c: number }).c).toBe(3);
    expect((one(raw, 'SELECT COUNT(*) c FROM outgoing_queue') as { c: number }).c).toBe(3);
  });
});
