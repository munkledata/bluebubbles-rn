/**
 * "Delete" on a message, end to end — the COMPOSITION, which is where this broke.
 *
 * `discardMessage` is two guarded steps: claim an unconfirmed optimistic row (hard delete + queue
 * row + echo-drop), otherwise fall through to the tombstone. Each step read correctly on its own
 * while the pair still destroyed a delivered message: on the guid-less ack paths (RCS bridge /
 * AppleScript) a SUCCESSFUL send keeps its `temp-` guid and only flips to 'sent', the guarded step
 * therefore declined it — and the fallback then hard-deleted it anyway because the guid started
 * with `temp-`. The server's fanout re-inserted it minutes later under `rcs-<id>` and the message
 * the user deleted was back for good.
 *
 * The barrel wires native modules at import time, so its native leaves are mocked (composition-root
 * clients / expo uploader / contacts picker); the DB and every repository call are real.
 */
import type Database from 'better-sqlite3';
import { Chat, Message } from '@core/models';
import {
  getChatIdByGuid,
  insertOutgoingText,
  listMessagesWithSenders,
  reconcileEchoByContent,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/clients', () => ({ http: {} })); // the real one builds the native vault
jest.mock('@/services/contacts/contactsService', () => ({ pickContact: jest.fn() }));
jest.mock('@/services/send/attachmentUpload', () => ({
  expoAttachmentUploader: jest.fn(),
  expoFileExists: jest.fn(async () => true),
}));
jest.mock('@ui/toast/toastStore', () => ({ showToast: jest.fn() }));

// eslint-disable-next-line import/first
import { discardMessage } from '@/services/send';
// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';

async function seedChat(db: AppDatabase): Promise<number> {
  const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
  await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: [{ address: 'a@b.com' }] })],
    handles,
  );
  return (await getChatIdByGuid(db, 'c1'))!;
}

const count = (raw: Database.Database, where: string, ...args: unknown[]): number =>
  (raw.prepare(`SELECT COUNT(*) c FROM messages WHERE ${where}`).get(...args) as { c: number }).c;
const queueCount = (raw: Database.Database, tempGuid: string): number =>
  (
    raw.prepare('SELECT COUNT(*) c FROM outgoing_queue WHERE temp_guid = ?').get(tempGuid) as {
      c: number;
    }
  ).c;

/**
 * The live fanout, exactly as DbEventSink applies it: content-reconcile the optimistic row, then
 * upsert the server's message. This is what re-materializes anything the delete destroyed.
 */
async function fanout(db: AppDatabase, chatId: number, guid: string, text: string): Promise<void> {
  const echo = { guid, isFromMe: true, text, dateCreated: 100 };
  await reconcileEchoByContent(db, echo, chatId);
  await upsertMessages(
    db,
    [Message.parse({ guid, isFromMe: true, text, dateCreated: 100 })],
    () => chatId,
    new Map(),
  );
}

describe('discardMessage — the two guarded steps together', () => {
  it('TOMBSTONES a temp- row that already reconciled to sent, and the fanout cannot bring it back', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    await insertOutgoingText(db, {
      tempGuid: 'temp-rcs',
      chatId,
      chatGuid: 'c1',
      text: 'sent over the bridge',
      now: 100,
    });
    // The RCS / AppleScript ack: state flips, the guid stays ours until the fanout lands.
    raw.prepare("UPDATE messages SET send_state='sent', error=0 WHERE guid='temp-rcs'").run();
    raw.prepare("DELETE FROM outgoing_queue WHERE temp_guid='temp-rcs'").run();

    await discardMessage('temp-rcs', 6_000);

    // Hard-deleting here is what let it come back: the row must survive as a tombstone.
    expect(count(raw, 'guid = ? AND date_deleted IS NOT NULL', 'temp-rcs')).toBe(1);
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);

    // Minutes later the server materializes the real identity.
    await fanout(db, chatId, 'rcs-77', 'sent over the bridge');

    // Promoted IN PLACE (guid rewritten, date_deleted rides along) and still hidden — and there is
    // exactly ONE row, so nothing was inserted alongside it.
    expect(count(raw, '1 = 1')).toBe(1);
    expect(count(raw, 'guid = ? AND date_deleted IS NOT NULL', 'rcs-77')).toBe(1);
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
  });

  it('TOMBSTONES a still-unconfirmed send, takes its queue row, and survives the fanout', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    await insertOutgoingText(db, {
      tempGuid: 'temp-live',
      chatId,
      chatGuid: 'c1',
      text: 'too late',
      now: 100,
    });

    await discardMessage('temp-live', 6_000);

    // 'sending' means the POST is at the server BY DEFINITION, so the row is exactly what the
    // echo needs to promote in place. Hard-deleting it left the echo nothing to attach the
    // deletion to and the cancelled message came back as an ordinary sent bubble.
    expect(count(raw, 'guid = ? AND date_deleted IS NOT NULL', 'temp-live')).toBe(1);
    expect(queueCount(raw, 'temp-live')).toBe(0); // …and no ladder left to re-send it
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);

    await fanout(db, chatId, 'real-live', 'too late');

    expect(count(raw, '1 = 1')).toBe(1);
    expect(count(raw, 'guid = ? AND date_deleted IS NOT NULL', 'real-live')).toBe(1);
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
  });

  it('still deletes when a stranded queue row survives next to an already-sent bubble', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    await insertOutgoingText(db, {
      tempGuid: 'temp-strand',
      chatId,
      chatGuid: 'c1',
      text: 'acked, queue row not yet cleared',
      now: 100,
    });
    raw.prepare("UPDATE messages SET send_state='sent', error=0 WHERE guid='temp-strand'").run();

    await discardMessage('temp-strand', 6_000);

    // The bug this pins: clearing the queue row used to be reported as "I handled the message", so
    // the tombstone was skipped and the bubble the user deleted just stayed on screen.
    expect(count(raw, 'guid = ? AND date_deleted IS NOT NULL', 'temp-strand')).toBe(1);
    expect(queueCount(raw, 'temp-strand')).toBe(0);
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
  });

  it('TOMBSTONES a real server guid rather than hard-deleting it', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    await upsertMessages(
      db,
      [Message.parse({ guid: 'rcs-5', isFromMe: true, text: 'delivered', dateCreated: 100 })],
      () => chatId,
      new Map(),
    );

    await discardMessage('rcs-5', 6_000);

    expect(count(raw, 'guid = ? AND date_deleted IS NOT NULL', 'rcs-5')).toBe(1);
    // A re-page of the thread must not undo it (date_deleted is absent from the conflict set).
    await upsertMessages(
      db,
      [Message.parse({ guid: 'rcs-5', isFromMe: true, text: 'delivered', dateCreated: 100 })],
      () => chatId,
      new Map(),
    );
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
  });
});
