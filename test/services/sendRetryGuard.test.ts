/**
 * "Try Again" on a failed bubble — the send barrel's `retry()`.
 *
 * THE CONTRACT IT HAS TO KEEP: supported plain text is re-POSTed from the QUEUE PAYLOAD under the
 * row's ORIGINAL temp guid. Rows requiring the retired Private API (including iMessage contact,
 * reply, effect, subject, and mention sends) are permanently retired without a network request.
 * Nothing is deleted: the failed bubble and capped retry row remain available for review/removal.
 *
 * The barrel wires native modules at import time, so the native leaves are mocked here
 * (composition-root clients / expo uploader / contacts picker); the DB and every repository call
 * are real, and the HTTP client is a fake whose POSTs are recorded.
 */
import type Database from 'better-sqlite3';
import { Chat, Message } from '@core/models';
import { logger } from '@core/secure';
import {
  getChatIdByGuid,
  insertOutgoingContact,
  insertOutgoingText,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/clients', () => {
  const http = {
    post: jest.fn(),
    pinTransport: () => http,
    assertTransportCurrent: () => undefined,
    isTransportCurrent: () => true,
  };
  return { http };
}); // real one builds the vault
jest.mock('@/services/contacts/contactsService', () => ({ pickContact: jest.fn() }));
jest.mock('@/services/send/attachmentUpload', () => ({
  expoAttachmentUploader: jest.fn(async () => ({ guid: 'up-1', viaPrivateApi: false })),
  expoFileExists: jest.fn(async () => true),
}));
jest.mock('@/services/send/outgoingPasteOwnership', () => ({
  createOutgoingPasteOwnershipPreparer: jest.fn(() => jest.fn()),
}));
// eslint-disable-next-line import/first
import { retry } from '@/services/send';
// eslint-disable-next-line import/first
import { http } from '@/services/clients';
// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';
// eslint-disable-next-line import/first -- composition-root/native dependencies above must be mocked first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

type JsonBody = Record<string, unknown>;
/** Every POST the retry made: `{ path, body }` (body = the request's `json` payload). */
const posts: Array<{ path: string; body: JsonBody }> = [];

async function seedChat(db: AppDatabase): Promise<number> {
  const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
  await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: [{ address: 'a@b.com' }] })],
    handles,
  );
  return (await getChatIdByGuid(db, 'c1'))!;
}

async function seedExactTextTarget(
  db: AppDatabase,
  chatId: number,
  guid: string,
  partIndex: number,
): Promise<void> {
  const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
  await upsertMessages(
    db,
    [
      Message.parse({
        guid,
        text: 'target',
        dateCreated: 500,
        messagePartTopology: {
          complete: true,
          originalPartIndexes: [partIndex],
          currentParts: [{ index: partIndex, kind: 'text' }],
          attachmentOwnership: [],
        },
      }),
    ],
    () => chatId,
    handles,
  );
}

/** Seed a failed optimistic TEXT send (message 'error' + a queue row with a spent attempt). */
async function seedFailedText(
  db: AppDatabase,
  raw: Database.Database,
  tempGuid: string,
  text: string,
): Promise<void> {
  const chatId = await seedChat(db);
  await insertOutgoingText(db, { tempGuid, chatId, chatGuid: 'c1', text, now: 1000 });
  raw.prepare("UPDATE messages SET send_state='error', error=502 WHERE guid=?").run(tempGuid);
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
  posts.length = 0;
  (http as unknown as { post: jest.Mock }).post = jest
    .fn()
    .mockImplementation(async (path: string, _schema: unknown, opts: { json: JsonBody }) => {
      posts.push({ path, body: opts.json });
      return { guid: 'real-1', dateCreated: 1000, dateDelivered: null };
    });
});

describe('retry() account handover', () => {
  it('does not report an old-account failure after Disconnect revokes the retry', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    (getDatabase as jest.Mock).mockImplementationOnce(() => {
      void pauseRealtimeDeliveries();
      throw new Error('old database was closed');
    });

    await expect(retry('temp-old-account')).resolves.toBe('stale');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rolls back a retired claim before POST and lets a fresh retry use the same temp guid', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const tempGuid = 'temp-retired-claim';
    await seedFailedText(db, raw, tempGuid, 'retry after retirement');
    raw
      .prepare('UPDATE messages SET error_message=? WHERE guid=?')
      .run('preserve this detail', tempGuid);
    raw
      .prepare('UPDATE outgoing_queue SET attempts=3, next_retry_at=123 WHERE temp_guid=?')
      .run(tempGuid);

    let drain: Promise<void> | undefined;
    let triggerRan = false;
    raw.function('pause_manual_retry_during_claim', () => {
      triggerRan = true;
      drain = pauseRealtimeDeliveries();
      return 0;
    });
    raw.exec(`
      CREATE TRIGGER pause_manual_retry_during_claim
      AFTER UPDATE OF send_state ON messages
      WHEN OLD.guid = '${tempGuid}' AND OLD.send_state = 'error' AND NEW.send_state = 'sending'
      BEGIN
        SELECT pause_manual_retry_during_claim();
      END
    `);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    try {
      await expect(retry(tempGuid)).resolves.toBe('stale');
      if (!drain) throw new Error('manual retry claim did not retire the account lease');
      await drain;

      expect(triggerRan).toBe(true);
      expect(posts).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      expect(
        raw
          .prepare(
            'SELECT send_state AS sendState, error, error_message AS errorMessage FROM messages WHERE guid=?',
          )
          .get(tempGuid),
      ).toEqual({ sendState: 'error', error: 502, errorMessage: 'preserve this detail' });
      expect(
        raw
          .prepare(
            'SELECT attempts, next_retry_at AS nextRetryAt FROM outgoing_queue WHERE temp_guid=?',
          )
          .get(tempGuid),
      ).toEqual({ attempts: 3, nextRetryAt: 123 });

      raw.exec('DROP TRIGGER pause_manual_retry_during_claim');
      resumeRealtimeDeliveries();
      let postRanInsideTransaction = false;
      (http as unknown as { post: jest.Mock }).post.mockImplementationOnce(
        async (path: string, _schema: unknown, opts: { json: JsonBody }) => {
          postRanInsideTransaction = raw.inTransaction;
          posts.push({ path, body: opts.json });
          return { guid: 'real-after-retirement', dateCreated: 1000, dateDelivered: null };
        },
      );

      await expect(retry(tempGuid)).resolves.toBe('retried');

      expect(postRanInsideTransaction).toBe(false);
      expect(posts).toHaveLength(1);
      expect(posts[0]?.body).toMatchObject({ tempGuid });
      expect(
        raw
          .prepare('SELECT send_state AS sendState FROM messages WHERE guid=?')
          .get('real-after-retirement'),
      ).toEqual({ sendState: 'sent' });
      expect(
        raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue WHERE temp_guid=?').get(tempGuid),
      ).toEqual({ count: 0 });
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS pause_manual_retry_during_claim');
      resumeRealtimeDeliveries();
      warn.mockRestore();
    }
  });
});

describe('retry() — re-sends the QUEUED send, not the bubble', () => {
  it('re-POSTs a failed text under its ORIGINAL temp guid (one idempotency key, not two)', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    await seedFailedText(db, raw, 'temp-old', 'try me again');

    await retry('temp-old');

    expect(posts).toHaveLength(1);
    // Minting a NEW temp guid here is what made an ack-lost send arrive twice: the server's
    // idempotency cache is keyed on exactly this value.
    expect(posts[0]?.body).toMatchObject({ tempGuid: 'temp-old', text: 'try me again' });
    // The row was PROMOTED, never deleted-and-recreated: same identity all the way through.
    expect(raw.prepare("SELECT COUNT(*) c FROM messages WHERE guid='real-1'").get()).toEqual({
      c: 1,
    });
    expect(raw.prepare('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 1 });
  });

  it('retires a legacy iMessage contact-card retry without POST', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    await insertOutgoingContact(db, {
      tempGuid: 'temp-card',
      chatId,
      chatGuid: 'c1',
      text: 'Craig Federighi',
      contact: { firstName: 'Craig', lastName: 'Federighi' },
      now: 1000,
    });
    raw.prepare("UPDATE messages SET send_state='error', error=502 WHERE guid='temp-card'").run();

    await expect(retry('temp-card')).resolves.toBe('unsendable');

    expect(posts).toHaveLength(0);
    expect(
      raw.prepare("SELECT send_state state FROM messages WHERE guid='temp-card'").get(),
    ).toEqual({
      state: 'error',
    });
    expect(
      raw.prepare("SELECT attempts FROM outgoing_queue WHERE temp_guid='temp-card'").get(),
    ).toEqual({
      attempts: 5,
    });
  });

  it('retires a legacy iMessage reply/effect/subject retry without POST', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    await seedExactTextTarget(db, chatId, 'orig-1', 0);
    await insertOutgoingText(db, {
      tempGuid: 'temp-rich',
      chatId,
      chatGuid: 'c1',
      text: 'sure',
      now: 1000,
      selectedMessageGuid: 'orig-1',
      partIndex: 0,
      effectId: 'com.apple.MobileSMS.expressivesend.impact',
      subject: 'Re: lunch',
    });
    raw.prepare("UPDATE messages SET send_state='error', error=502 WHERE guid='temp-rich'").run();

    await expect(retry('temp-rich')).resolves.toBe('unsendable');

    expect(posts).toHaveLength(0);
    expect(
      raw.prepare("SELECT send_state state FROM messages WHERE guid='temp-rich'").get(),
    ).toEqual({
      state: 'error',
    });
    expect(
      raw.prepare("SELECT attempts FROM outgoing_queue WHERE temp_guid='temp-rich'").get(),
    ).toEqual({
      attempts: 5,
    });
  });
});

/**
 * The duplicate-delivery guard. The chat drains the outgoing queue every 20 s, and the drain flips
 * a failed row to 'sending' before it POSTs — so by the time the user taps "Try Again" on a sheet
 * that opened a moment earlier, the row may be mid-flight or already delivered.
 */
describe('retry() vs the automatic retry drain', () => {
  it('does NOT re-send a row the drain has taken over (still sending), and leaves it intact', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    await seedFailedText(db, raw, 'temp-inflight', 'in flight');
    // The drain claimed it and is mid-POST.
    raw
      .prepare("UPDATE messages SET send_state='sending', error=0 WHERE guid='temp-inflight'")
      .run();

    await expect(retry('temp-inflight')).resolves.toBe('already-sending');

    expect(posts).toHaveLength(0); // nothing re-sent
    // The bubble AND its retry ladder survive — touching either would void a live lease.
    expect(raw.prepare("SELECT COUNT(*) c FROM messages WHERE guid='temp-inflight'").get()).toEqual(
      { c: 1 },
    );
    expect(
      raw.prepare("SELECT COUNT(*) c FROM outgoing_queue WHERE temp_guid='temp-inflight'").get(),
    ).toEqual({ c: 1 });
  });

  it('does NOT re-send a message that was already delivered under its own temp guid', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    await seedFailedText(db, raw, 'temp-ok', 'already gone');
    // The RCS bridge / AppleScript ack keeps the temp guid and only flips the state.
    raw.prepare("UPDATE messages SET send_state='sent', error=0 WHERE guid='temp-ok'").run();

    await expect(retry('temp-ok')).resolves.toBe('already-settled');

    expect(posts).toHaveLength(0);
    expect(raw.prepare('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 1 });
  });

  /**
   * No queue row = no payload, so there is nothing honest to re-POST. The old code "rebuilt" the
   * send from the bubble anyway — for a real server guid that meant DELETING a delivered message
   * and sending a fresh copy of its text.
   */
  it('refuses (and says so) when the errored row has no ladder left, without touching it', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    await seedFailedText(db, raw, 'temp-noqueue', 'orphaned');
    raw.prepare("DELETE FROM outgoing_queue WHERE temp_guid='temp-noqueue'").run();

    await expect(retry('temp-noqueue')).resolves.toBe('unretryable');

    expect(posts).toHaveLength(0);
    expect(
      raw.prepare("SELECT send_state s FROM messages WHERE guid='temp-noqueue'").get(),
    ).toEqual({ s: 'error' });
  });
});
