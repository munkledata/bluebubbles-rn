/**
 * "Try Again" on a failed bubble — the send barrel's `retry()`.
 *
 * THE CONTRACT IT HAS TO KEEP: re-POST the QUEUE PAYLOAD under the row's ORIGINAL temp guid. The
 * old shape deleted the errored row and re-sent whatever the sheet could see, which broke three
 * ways at once — a failed CONTACT CARD went out as a plain message reading the contact's display
 * name; the fresh temp guid is a second idempotency key at the server, so an ack-lost send is
 * delivered twice; and the user's only copy of the message was destroyed before any replacement
 * existed, so a throw in the re-send lost it outright with no error shown (the caller is `void`).
 *
 * The barrel wires native modules at import time, so the native leaves are mocked here
 * (composition-root clients / expo uploader / contacts picker); the DB and every repository call
 * are real, and the HTTP client is a fake whose POSTs are recorded.
 */
import type Database from 'better-sqlite3';
import { Chat } from '@core/models';
import { logger } from '@core/secure';
import {
  getChatIdByGuid,
  insertOutgoingContact,
  insertOutgoingText,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/clients', () => ({ http: { post: jest.fn() } })); // real one builds the vault
jest.mock('@/services/contacts/contactsService', () => ({ pickContact: jest.fn() }));
jest.mock('@/services/send/attachmentUpload', () => ({
  expoAttachmentUploader: jest.fn(async () => ({ guid: 'up-1', viaPrivateApi: false })),
  expoFileExists: jest.fn(async () => true),
}));
jest.mock('@ui/toast/toastStore', () => ({ showToast: jest.fn() }));

// eslint-disable-next-line import/first
import { retry } from '@/services/send';
// eslint-disable-next-line import/first
import { http } from '@/services/clients';
// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';
// eslint-disable-next-line import/first
import { showToast } from '@ui/toast/toastStore';
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

    await expect(retry('temp-old-account')).resolves.toBeUndefined();

    expect(showToast).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
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
    expect(showToast).not.toHaveBeenCalled();
  });

  /**
   * THE contact-card regression. `insertOutgoingContact` stores a `kind:'contact'` queue row plus a
   * placeholder bubble whose TEXT is the contact's display name — so rebuilding the send from the
   * bubble delivered "Craig Federighi" to the recipient as a plain message.
   */
  it('re-POSTs a failed CONTACT CARD as a contact, not as the placeholder text', async () => {
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

    await retry('temp-card');

    expect(posts).toHaveLength(1);
    expect(posts[0]?.path).toContain('contact');
    expect(posts[0]?.body).toMatchObject({
      tempGuid: 'temp-card',
      firstName: 'Craig',
      lastName: 'Federighi',
    });
    // The one assertion that fails against the old code: it POSTed the display name as a message.
    expect(posts[0]?.path).not.toContain('text');
    expect(posts[0]?.body.text).toBeUndefined();
  });

  it('keeps the reply target / effect / subject the payload carries and the bubble does not', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const chatId = await seedChat(db);
    await insertOutgoingText(db, {
      tempGuid: 'temp-rich',
      chatId,
      chatGuid: 'c1',
      text: 'sure',
      now: 1000,
      selectedMessageGuid: 'orig-1',
      effectId: 'com.apple.MobileSMS.expressivesend.impact',
      subject: 'Re: lunch',
    });
    raw.prepare("UPDATE messages SET send_state='error', error=502 WHERE guid='temp-rich'").run();

    await retry('temp-rich');

    expect(posts[0]?.body).toMatchObject({
      tempGuid: 'temp-rich',
      selectedMessageGuid: 'orig-1',
      effectId: 'com.apple.MobileSMS.expressivesend.impact',
      subject: 'Re: lunch',
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

    await retry('temp-inflight');

    expect(posts).toHaveLength(0); // nothing re-sent
    expect(showToast).toHaveBeenCalledWith('Already trying to send this message');
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

    await retry('temp-ok');

    expect(posts).toHaveLength(0);
    expect(showToast).toHaveBeenCalledWith('Message was already sent');
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

    await retry('temp-noqueue');

    expect(posts).toHaveLength(0);
    expect(showToast).toHaveBeenCalledWith('This message can’t be sent again');
    expect(
      raw.prepare("SELECT send_state s FROM messages WHERE guid='temp-noqueue'").get(),
    ).toEqual({ s: 'error' });
  });
});
