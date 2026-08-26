/**
 * "Delete" on a message, end to end — the COMPOSITION, which is where this broke.
 *
 * `discardMessage` is two guarded steps: claim and tombstone an unconfirmed optimistic row while
 * removing its queue row, otherwise fall through to the general tombstone. Each step read correctly on its own
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
  deleteMessageLocal,
  getChatIdByGuid,
  insertOutgoingAttachment,
  insertOutgoingText,
  listAttachmentsByMessageIds,
  listMessagesWithSenders,
  MESSAGE_GUID_ALIAS_LIMIT,
  MessageGuidAliasConflictError,
  reconcileEchoByContent,
  reconcileOutgoingAttachmentByContent,
  reconcileOutgoingSuccess,
  upsertChats,
  upsertHandles,
  upsertMessages,
  upsertMessagesWithinTransaction,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/clients', () => ({ http: {} })); // the real one builds the native vault
jest.mock('@/services/contacts/contactsService', () => ({ pickContact: jest.fn() }));
jest.mock('@/services/send/attachmentUpload', () => ({
  expoAttachmentUploader: jest.fn(),
  expoFileExists: jest.fn(async () => true),
}));
jest.mock('@/services/send/sendFailureNotice', () => ({
  clearFailedSendNotice: jest.fn(async () => undefined),
  notifyFailedSend: jest.fn(async () => undefined),
}));
jest.mock('@ui/toast/toastStore', () => ({ showToast: jest.fn() }));

// eslint-disable-next-line import/first
import { discardMessage } from '@/services/send';
// eslint-disable-next-line import/first
import { clearFailedSendNotice } from '@/services/send/sendFailureNotice';
// eslint-disable-next-line import/first
import { uploadRegistry } from '@/services/send/uploadControl';
// eslint-disable-next-line import/first
import { attachmentCacheCoordinator } from '@/services/download/attachmentCacheCoordinator';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';
// eslint-disable-next-line import/first
import { showToast } from '@ui/toast/toastStore';

jest.setTimeout(120_000);

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
const aliasRows = (
  raw: Database.Database,
): Array<{ id: number; alias: string; canonical: string }> =>
  raw
    .prepare(
      `SELECT id, alias_guid AS alias, canonical_guid AS canonical
         FROM message_guid_aliases ORDER BY id`,
    )
    .all() as Array<{ id: number; alias: string; canonical: string }>;
const ledgerRows = (raw: Database.Database): Array<{ guid: string; dateDeleted: number }> =>
  raw
    .prepare(
      `SELECT guid, date_deleted AS dateDeleted
         FROM message_deletion_ledger ORDER BY guid`,
    )
    .all() as Array<{ guid: string; dateDeleted: number }>;
const deletionDate = (raw: Database.Database, guid: string): number | null | undefined =>
  (
    raw.prepare('SELECT date_deleted AS dateDeleted FROM messages WHERE guid = ?').get(guid) as
      { dateDeleted: number | null } | undefined
  )?.dateDeleted;

/**
 * The live fanout, exactly as DbEventSink applies it: content-reconcile the optimistic row, then
 * upsert the server's message. This is what re-materializes anything the delete destroyed.
 */
async function fanout(db: AppDatabase, chatId: number, guid: string, text: string): Promise<void> {
  const echo = { guid, isFromMe: true, text, dateCreated: 100 };
  await withDbTransaction(db, (context) => reconcileEchoByContent(context, echo, chatId));
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

  it('withdraws an existing failed-send notice only after the row is durably tombstoned', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    await insertOutgoingText(db, {
      tempGuid: 'temp-failed-notice',
      chatId,
      chatGuid: 'c1',
      text: 'remove this failed send',
      now: 100,
    });
    raw
      .prepare("UPDATE messages SET send_state='error', error=500 WHERE guid='temp-failed-notice'")
      .run();
    (clearFailedSendNotice as jest.Mock).mockImplementationOnce(
      async (_db: AppDatabase, guid: string, guard?: () => boolean) => {
        expect(guid).toBe('temp-failed-notice');
        expect(guard?.()).toBe(true);
        expect(deletionDate(raw, guid)).toBe(6_000);
      },
    );

    await discardMessage('temp-failed-notice', 6_000);

    expect(clearFailedSendNotice).toHaveBeenCalledWith(
      db,
      'temp-failed-notice',
      expect.any(Function),
    );
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

  it('rolls back a retired stranded-row discard and lets a fresh attempt commit every effect', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    const tempGuid = 'temp-discard-retired';
    await upsertMessages(
      db,
      [Message.parse({ guid: 'older-message', text: 'older', dateCreated: 50 })],
      () => chatId,
      new Map(),
    );
    await insertOutgoingText(db, {
      tempGuid,
      chatId,
      chatGuid: 'c1',
      text: 'discard after retirement',
      now: 100,
    });
    // A guid-less ack can mark the bubble sent before its queue cleanup commits. The discard claim
    // must decline this row, but its queue cleanup and fallback tombstone still share one owner.
    raw.prepare("UPDATE messages SET send_state='sent', error=0 WHERE guid=?").run(tempGuid);

    let drain: Promise<void> | undefined;
    let triggerRan = false;
    raw.function('pause_discard_during_fallback_tombstone', () => {
      triggerRan = true;
      drain = pauseRealtimeDeliveries();
      return 0;
    });
    raw.exec(`
      CREATE TRIGGER pause_discard_during_fallback_tombstone
      AFTER INSERT ON message_deletion_ledger
      WHEN NEW.guid = '${tempGuid}'
      BEGIN
        SELECT pause_discard_during_fallback_tombstone();
      END
    `);

    const cleanupTransactionStates: boolean[] = [];
    const uploadCancelTransactionStates: boolean[] = [];
    const cancelUpload = jest.spyOn(uploadRegistry, 'cancel').mockImplementation(() => {
      uploadCancelTransactionStates.push(raw.inTransaction);
      return false;
    });
    const emptyCleanup = {
      status: 'complete' as const,
      attempted: 0,
      confirmed: 0,
      failed: 0,
      skipped: 0,
    };
    const retire = jest
      .spyOn(attachmentCacheCoordinator, 'retireInactiveEntries')
      .mockImplementation(async () => {
        cleanupTransactionStates.push(raw.inTransaction);
        return emptyCleanup;
      });
    const drainCache = jest
      .spyOn(attachmentCacheCoordinator, 'drainDueRetirements')
      .mockImplementation(async () => {
        cleanupTransactionStates.push(raw.inTransaction);
        return emptyCleanup;
      });

    try {
      await expect(discardMessage(tempGuid, 6_000)).resolves.toBeUndefined();
      if (!drain)
        throw new Error('discard did not retire the account lease during fallback tombstoning');
      await drain;

      expect(triggerRan).toBe(true);
      expect(raw.inTransaction).toBe(false);
      expect(
        raw
          .prepare(
            'SELECT send_state AS sendState, error, date_deleted AS dateDeleted FROM messages WHERE guid=?',
          )
          .get(tempGuid),
      ).toEqual({ sendState: 'sent', error: 0, dateDeleted: null });
      expect(queueCount(raw, tempGuid)).toBe(1);
      expect(ledgerRows(raw)).toEqual([]);
      expect(
        raw.prepare('SELECT latest_message_date AS latest FROM chats WHERE id=?').get(chatId),
      ).toEqual({ latest: 100 });
      expect(showToast).not.toHaveBeenCalled();
      expect(clearFailedSendNotice).not.toHaveBeenCalled();
      expect(retire).not.toHaveBeenCalled();
      expect(drainCache).not.toHaveBeenCalled();

      raw.exec('DROP TRIGGER pause_discard_during_fallback_tombstone');
      resumeRealtimeDeliveries();
      (clearFailedSendNotice as jest.Mock).mockImplementationOnce(async () => {
        cleanupTransactionStates.push(raw.inTransaction);
      });

      await expect(discardMessage(tempGuid, 6_000)).resolves.toBeUndefined();

      expect(deletionDate(raw, tempGuid)).toBe(6_000);
      expect(queueCount(raw, tempGuid)).toBe(0);
      expect(ledgerRows(raw)).toEqual([{ guid: tempGuid, dateDeleted: 6_000 }]);
      expect(
        raw.prepare('SELECT latest_message_date AS latest FROM chats WHERE id=?').get(chatId),
      ).toEqual({ latest: 50 });
      expect(showToast).not.toHaveBeenCalled();
      expect(clearFailedSendNotice).toHaveBeenCalledTimes(1);
      expect(retire).toHaveBeenCalledTimes(1);
      expect(drainCache).toHaveBeenCalledTimes(1);
      expect(uploadCancelTransactionStates).toEqual([false, false]);
      expect(cleanupTransactionStates).toEqual([false, false, false]);
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS pause_discard_during_fallback_tombstone');
      if (drain) await drain;
      resumeRealtimeDeliveries();
      cancelUpload.mockRestore();
      retire.mockRestore();
      drainCache.mockRestore();
    }
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

  it('resolves a stale temp confirmation after an HTTP ack promoted the row in place', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    await insertOutgoingText(db, {
      tempGuid: 'temp-stale-http',
      chatId,
      chatGuid: 'c1',
      text: 'promoted while the dialog was open',
      now: 100,
    });
    await reconcileOutgoingSuccess(db, 'temp-stale-http', {
      guid: 'real-stale-http',
      dateCreated: 200,
      dateDelivered: 300,
    });

    await discardMessage('temp-stale-http', 6_000);

    expect(count(raw, 'guid = ? AND date_deleted = ?', 'real-stale-http', 6_000)).toBe(1);
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
    expect(ledgerRows(raw)).toEqual([{ guid: 'real-stale-http', dateDeleted: 6_000 }]);
    expect(aliasRows(raw)).toEqual([
      expect.objectContaining({ alias: 'temp-stale-http', canonical: 'real-stale-http' }),
    ]);
  });

  it('resolves a stale temp confirmation when the HTTP ack took the duplicate-real branch', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    await insertOutgoingText(db, {
      tempGuid: 'temp-stale-duplicate',
      chatId,
      chatGuid: 'c1',
      text: 'optimistic wording',
      now: 100,
    });
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'real-stale-duplicate',
          isFromMe: true,
          text: 'server wording',
          dateCreated: 200,
        }),
      ],
      () => chatId,
      new Map(),
    );
    await reconcileOutgoingSuccess(db, 'temp-stale-duplicate', {
      guid: 'real-stale-duplicate',
      dateCreated: 200,
      dateDelivered: 300,
    });

    await discardMessage('temp-stale-duplicate', 6_000);

    expect(count(raw, 'guid = ? AND date_deleted = ?', 'real-stale-duplicate', 6_000)).toBe(1);
    expect(count(raw, 'guid = ?', 'temp-stale-duplicate')).toBe(0);
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
  });

  it('resolves a stale temp confirmation after the live content echo promoted it', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    await insertOutgoingText(db, {
      tempGuid: 'temp-stale-content',
      chatId,
      chatGuid: 'c1',
      text: 'same live echo',
      now: 100,
    });
    const echo = Message.parse({
      guid: 'real-stale-content',
      isFromMe: true,
      text: 'same live echo',
      dateCreated: 100,
    });
    await withDbTransaction(db, async (context) => {
      await reconcileEchoByContent(context, echo, chatId);
      await upsertMessagesWithinTransaction(context, [echo], () => chatId, new Map());
    });

    expect(aliasRows(raw)).toEqual([
      expect.objectContaining({
        alias: 'temp-stale-content',
        canonical: 'real-stale-content',
      }),
    ]);
    await discardMessage('temp-stale-content', 6_000);

    expect(deletionDate(raw, 'real-stale-content')).toBe(6_000);
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
  });

  it('resolves a stale temp confirmation after sync-safe attachment promotion', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-stale-attachment',
      attachmentGuid: 'temp-stale-attachment-att',
      chatId,
      chatGuid: 'c1',
      localPath: 'file:///stale.jpg',
      mimeType: 'image/jpeg',
      transferName: 'stale.jpg',
      totalBytes: 10,
      now: 100,
    });
    const echo = Message.parse({
      guid: 'real-stale-attachment',
      isFromMe: true,
      text: null,
      dateCreated: 100,
    });
    await reconcileOutgoingAttachmentByContent(db, echo, chatId);
    await upsertMessages(db, [echo], () => chatId, new Map());

    expect(aliasRows(raw)).toEqual([
      expect.objectContaining({
        alias: 'temp-stale-attachment',
        canonical: 'real-stale-attachment',
      }),
    ]);
    const realId = (
      raw.prepare("SELECT id FROM messages WHERE guid = 'real-stale-attachment'").get() as {
        id: number;
      }
    ).id;
    expect((await listAttachmentsByMessageIds(db, [realId])).get(realId)?.[0]?.localPath).toBe(
      'file:///stale.jpg',
    );

    await discardMessage('temp-stale-attachment', 6_000);
    expect(deletionDate(raw, 'real-stale-attachment')).toBe(6_000);
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
  });

  it('keeps delete-before-promotion ordering hidden after the real identity arrives', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    await insertOutgoingText(db, {
      tempGuid: 'temp-delete-first',
      chatId,
      chatGuid: 'c1',
      text: 'delete won first',
      now: 100,
    });

    await discardMessage('temp-delete-first', 6_000);
    await reconcileOutgoingSuccess(db, 'temp-delete-first', {
      guid: 'real-delete-first',
      dateCreated: 200,
      dateDelivered: 300,
    });

    expect(deletionDate(raw, 'real-delete-first')).toBe(6_000);
    expect(ledgerRows(raw)).toEqual([{ guid: 'real-delete-first', dateDeleted: 6_000 }]);
    expect(aliasRows(raw)).toEqual([
      expect.objectContaining({ alias: 'temp-delete-first', canonical: 'real-delete-first' }),
    ]);
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
  });

  it('resolves the alias after a row purge and makes a later real re-ingestion start hidden', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    await insertOutgoingText(db, {
      tempGuid: 'temp-purged-alias',
      chatId,
      chatGuid: 'c1',
      text: 'purged before confirmation',
      now: 100,
    });
    await reconcileOutgoingSuccess(db, 'temp-purged-alias', {
      guid: 'real-purged-alias',
      dateCreated: 200,
      dateDelivered: 300,
    });
    raw.prepare("DELETE FROM messages WHERE guid = 'real-purged-alias'").run();

    await discardMessage('temp-purged-alias', 6_000);
    expect(ledgerRows(raw)).toEqual([{ guid: 'real-purged-alias', dateDeleted: 6_000 }]);
    expect(showToast).not.toHaveBeenCalled();

    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'real-purged-alias',
          isFromMe: true,
          text: 'purged before confirmation',
          dateCreated: 200,
        }),
      ],
      () => chatId,
      new Map(),
    );
    expect(deletionDate(raw, 'real-purged-alias')).toBe(6_000);
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
  });

  it('maps identical sends exactly and deletes only the selected temp identity', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    for (const [tempGuid, now] of [
      ['temp-identical-a', 100],
      ['temp-identical-b', 101],
    ] as const) {
      await insertOutgoingText(db, {
        tempGuid,
        chatId,
        chatGuid: 'c1',
        text: 'identical words',
        now,
      });
    }
    await reconcileOutgoingSuccess(db, 'temp-identical-a', {
      guid: 'real-identical-a',
      dateCreated: 200,
      dateDelivered: null,
    });
    await reconcileOutgoingSuccess(db, 'temp-identical-b', {
      guid: 'real-identical-b',
      dateCreated: 201,
      dateDelivered: null,
    });

    await discardMessage('temp-identical-a', 6_000);

    expect(deletionDate(raw, 'real-identical-a')).toBe(6_000);
    expect(deletionDate(raw, 'real-identical-b')).toBeNull();
    expect((await listMessagesWithSenders(db, chatId)).map((row) => row.guid)).toEqual([
      'real-identical-b',
    ]);
  });

  it('allows many exact aliases to one canonical row and refreshes an idempotent mapping recency', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    await upsertMessages(
      db,
      [Message.parse({ guid: 'real-shared', isFromMe: true, text: 'shared', dateCreated: 200 })],
      () => chatId,
      new Map(),
    );
    for (const tempGuid of ['temp-shared-a', 'temp-shared-b', 'temp-shared-c']) {
      await insertOutgoingText(db, {
        tempGuid,
        chatId,
        chatGuid: 'c1',
        text: 'shared',
        now: 100,
      });
      await reconcileOutgoingSuccess(db, tempGuid, {
        guid: 'real-shared',
        dateCreated: 200,
        dateDelivered: null,
      });
    }
    const beforeRefresh = aliasRows(raw);
    expect(beforeRefresh.map(({ alias, canonical }) => ({ alias, canonical }))).toEqual([
      { alias: 'temp-shared-a', canonical: 'real-shared' },
      { alias: 'temp-shared-b', canonical: 'real-shared' },
      { alias: 'temp-shared-c', canonical: 'real-shared' },
    ]);

    await reconcileOutgoingSuccess(db, 'temp-shared-a', {
      guid: 'real-shared',
      dateCreated: 200,
      dateDelivered: null,
    });
    const afterRefresh = aliasRows(raw);
    expect(afterRefresh.map(({ alias }) => alias)).toEqual([
      'temp-shared-b',
      'temp-shared-c',
      'temp-shared-a',
    ]);
    expect(afterRefresh[2]?.id).toBeGreaterThan(beforeRefresh[2]!.id);

    await discardMessage('temp-shared-b', 6_000);
    expect(deletionDate(raw, 'real-shared')).toBe(6_000);
  });

  it('fails closed and rolls the promotion back when an alias conflicts with another canonical identity', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    await insertOutgoingText(db, {
      tempGuid: 'temp-conflict',
      chatId,
      chatGuid: 'c1',
      text: 'one identity only',
      now: 100,
    });
    await reconcileOutgoingSuccess(db, 'temp-conflict', {
      guid: 'real-conflict-a',
      dateCreated: 200,
      dateDelivered: null,
    });
    await upsertMessages(
      db,
      [Message.parse({ guid: 'real-conflict-b', isFromMe: true, text: 'other', dateCreated: 201 })],
      () => chatId,
      new Map(),
    );

    const conflictError = await reconcileOutgoingSuccess(db, 'temp-conflict', {
      guid: 'real-conflict-b',
      dateCreated: 201,
      dateDelivered: null,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(conflictError).toBeInstanceOf(MessageGuidAliasConflictError);
    expect(conflictError).toEqual(
      expect.objectContaining({
        message: 'message GUID alias conflicts with an existing canonical identity',
      }),
    );
    expect(String(conflictError)).not.toMatch(/temp-conflict|real-conflict/);

    expect(aliasRows(raw)).toEqual([
      expect.objectContaining({ alias: 'temp-conflict', canonical: 'real-conflict-a' }),
    ]);
    expect(deletionDate(raw, 'real-conflict-a')).toBeNull();
    expect(deletionDate(raw, 'real-conflict-b')).toBeNull();
  });

  it('prefers an exact current temp row over an older alias with the same key', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db);
    await insertOutgoingText(db, {
      tempGuid: 'temp-reused-exact',
      chatId,
      chatGuid: 'c1',
      text: 'original',
      now: 100,
    });
    await reconcileOutgoingSuccess(db, 'temp-reused-exact', {
      guid: 'real-original',
      dateCreated: 200,
      dateDelivered: null,
    });
    raw
      .prepare(
        `INSERT INTO messages
           (guid, chat_id, text, is_from_me, date_created, send_state, error)
         VALUES ('temp-reused-exact', ?, 'new exact row', 1, 300, 'sent', 0)`,
      )
      .run(chatId);

    await expect(deleteMessageLocal(db, 'temp-reused-exact', 6_000)).resolves.toBe('applied');

    expect(deletionDate(raw, 'temp-reused-exact')).toBe(6_000);
    expect(deletionDate(raw, 'real-original')).toBeNull();
    expect(ledgerRows(raw)).toEqual([{ guid: 'temp-reused-exact', dateDeleted: 6_000 }]);
  });

  it('returns unresolved for an unknown temp and the service surfaces fixed, identifier-free copy', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'real-unrelated',
          isFromMe: true,
          text: 'keep me',
          dateCreated: 100,
        }),
      ],
      () => chatId,
      new Map(),
    );

    await expect(deleteMessageLocal(db, 'temp-no-retained-alias', 5_999)).resolves.toBe(
      'unresolved-temp',
    );
    await discardMessage('temp-no-retained-alias', 6_000);

    expect(deletionDate(raw, 'real-unrelated')).toBeNull();
    expect(ledgerRows(raw)).toEqual([{ guid: 'temp-no-retained-alias', dateDeleted: 6_000 }]);
    expect(showToast).toHaveBeenCalledWith('Message changed—select it again');
    expect(showToast).not.toHaveBeenCalledWith(expect.stringContaining('temp-no-retained-alias'));
  });

  it('rolls alias creation back when the message identity promotion fails', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    await insertOutgoingText(db, {
      tempGuid: 'temp-promotion-failure',
      chatId,
      chatGuid: 'c1',
      text: 'stay temp on rollback',
      now: 100,
    });
    // Fail the first Drizzle UPDATE in this operation. The alias insert/prune uses SELECT,
    // INSERT, DELETE and raw run; the next statement is the message-identity UPDATE. The former
    // native-trigger injection was observed to depend on full-suite execution order, so use the
    // owned database method as a deterministic boundary while keeping the real transaction.
    const updateSpy = jest.spyOn(
      db as unknown as { update: (...args: unknown[]) => unknown },
      'update',
    );
    updateSpy.mockImplementationOnce(() => {
      throw new Error('planned identity promotion failure');
    });

    try {
      await expect(
        reconcileOutgoingSuccess(db, 'temp-promotion-failure', {
          guid: 'real-promotion-failure',
          dateCreated: 200,
          dateDelivered: null,
        }),
      ).rejects.toThrow('planned identity promotion failure');
    } finally {
      updateSpy.mockRestore();
    }

    expect(aliasRows(raw)).toEqual([]);
    expect(count(raw, 'guid = ?', 'temp-promotion-failure')).toBe(1);
    expect(queueCount(raw, 'temp-promotion-failure')).toBe(1);
    expect(count(raw, 'guid = ?', 'real-promotion-failure')).toBe(0);
  });

  it('rolls alias-resolved ledger and tombstone writes back when chat-sort recompute fails', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    await insertOutgoingText(db, {
      tempGuid: 'temp-delete-failure',
      chatId,
      chatGuid: 'c1',
      text: 'all or nothing delete',
      now: 100,
    });
    await reconcileOutgoingSuccess(db, 'temp-delete-failure', {
      guid: 'real-delete-failure',
      dateCreated: 200,
      dateDelivered: null,
    });
    raw.exec(`
      CREATE TRIGGER fail_alias_delete_chat_sort
      BEFORE UPDATE OF latest_message_date ON chats
      WHEN NEW.id = ${chatId}
      BEGIN
        SELECT RAISE(ABORT, 'planned alias delete failure');
      END
    `);

    await expect(deleteMessageLocal(db, 'temp-delete-failure', 6_000)).rejects.toThrow(
      /Failed to run the query/,
    );

    expect(deletionDate(raw, 'real-delete-failure')).toBeNull();
    expect(ledgerRows(raw)).toEqual([]);
    expect(aliasRows(raw)).toEqual([
      expect.objectContaining({ alias: 'temp-delete-failure', canonical: 'real-delete-failure' }),
    ]);
  });

  it('evicts exactly the oldest of 4097 aliases and visibly refuses that unresolved stale temp', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    expect(MESSAGE_GUID_ALIAS_LIMIT).toBe(4096);
    const insertAlias = raw.prepare(
      `INSERT INTO message_guid_aliases (alias_guid, canonical_guid) VALUES (?, ?)`,
    );
    const insertMessage = raw.prepare(
      `INSERT INTO messages
         (guid, chat_id, text, is_from_me, date_created, send_state, error)
       VALUES (?, ?, 'capacity', 1, ?, 'sent', 0)`,
    );
    raw.transaction(() => {
      for (let i = 0; i < MESSAGE_GUID_ALIAS_LIMIT; i += 1) {
        const suffix = i.toString().padStart(4, '0');
        insertAlias.run(`temp-cap-${suffix}`, `real-cap-${suffix}`);
      }
      // Only the evicted alias's canonical row needs to exist to prove the unresolved action stays
      // visibly unapplied. The other 4,095 seed rows are aliases only; migration starts empty, so
      // bulk-seeding the valid pre-cap state keeps this boundary test fast and deterministic.
      insertMessage.run('real-cap-0000', chatId, 1);
    })();
    await insertOutgoingText(db, {
      tempGuid: 'temp-cap-4096',
      chatId,
      chatGuid: 'c1',
      text: 'capacity',
      now: 4097,
    });
    await reconcileOutgoingSuccess(db, 'temp-cap-4096', {
      guid: 'real-cap-4096',
      dateCreated: 4097,
      dateDelivered: null,
    });

    expect(aliasRows(raw)).toHaveLength(MESSAGE_GUID_ALIAS_LIMIT);
    expect(
      raw
        .prepare('SELECT canonical_guid FROM message_guid_aliases WHERE alias_guid = ?')
        .get('temp-cap-0000'),
    ).toBeUndefined();
    expect(
      raw
        .prepare('SELECT canonical_guid AS canonical FROM message_guid_aliases ORDER BY id LIMIT 1')
        .get(),
    ).toEqual({ canonical: 'real-cap-0001' });
    expect(
      raw
        .prepare(
          'SELECT canonical_guid AS canonical FROM message_guid_aliases ORDER BY id DESC LIMIT 1',
        )
        .get(),
    ).toEqual({ canonical: 'real-cap-4096' });

    await discardMessage('temp-cap-0000', 6_000);

    expect(deletionDate(raw, 'real-cap-0000')).toBeNull();
    expect(ledgerRows(raw)).toContainEqual({ guid: 'temp-cap-0000', dateDeleted: 6_000 });
    expect(showToast).toHaveBeenCalledWith('Message changed—select it again');
  });
});
