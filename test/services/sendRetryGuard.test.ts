/**
 * Locks the manual-retry guard in the send barrel's `retry()`: when a failed ATTACHMENT's
 * local file is gone, MessageList can only rebuild `{ text: '' }` (no image) — the old code
 * then deleted the errored bubble and POSTed an EMPTY text, silently destroying the user's
 * message. The guard must keep the bubble untouched (Delete on the sheet still works), show
 * a toast, and never touch the DB; a retry that HAS content must still flow through.
 *
 * The barrel wires native modules at import time, so the native leaves are mocked here
 * (composition-root clients / expo uploader / contacts picker); everything else is real.
 */
import type Database from 'better-sqlite3';
import { Chat } from '@core/models';
import { getChatIdByGuid, insertOutgoingText, upsertChats, upsertHandles } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/clients', () => ({ http: {} })); // real one builds the native vault
jest.mock('@/services/contacts/contactsService', () => ({ pickContact: jest.fn() }));
jest.mock('@/services/send/attachmentUpload', () => ({
  expoAttachmentUploader: jest.fn(async () => ({ guid: 'up-1', viaPrivateApi: false })),
  expoFileExists: jest.fn(async () => true),
}));
jest.mock('@ui/toast/toastStore', () => ({ showToast: jest.fn() }));

// eslint-disable-next-line import/first
import { retry } from '@/services/send';
// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';
// eslint-disable-next-line import/first
import { showToast } from '@ui/toast/toastStore';

async function seedFailedText(
  db: AppDatabase,
  raw: Database.Database,
  tempGuid: string,
  text: string,
): Promise<void> {
  const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
  await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: [{ address: 'a@b.com' }] })],
    handles,
  );
  const chatId = await getChatIdByGuid(db, 'c1');
  await insertOutgoingText(db, { tempGuid, chatId: chatId!, chatGuid: 'c1', text, now: 1000 });
  raw.prepare("UPDATE messages SET send_state='error', error=502 WHERE guid=?").run(tempGuid);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('retry() manual-retry guard', () => {
  it('no image + blank text → keeps the failed bubble, toasts, and never touches the DB', async () => {
    (getDatabase as jest.Mock).mockImplementation(() => {
      throw new Error('DB must not be touched on the guarded path');
    });

    const res = await retry('temp-gone-file', { chatGuid: 'c1', text: '   ' });
    expect(res).toEqual({ tempGuid: 'temp-gone-file' }); // old bubble kept, nothing re-sent
    expect(showToast).toHaveBeenCalledWith('Original file is no longer available');
    expect(getDatabase).not.toHaveBeenCalled();
  });

  it('with text present → still deletes the old errored row and re-sends as a fresh temp row', async () => {
    const { db, raw } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    await seedFailedText(db, raw, 'temp-old', 'try me again');

    const res = await retry('temp-old', { chatGuid: 'c1', text: 'try me again' });
    // Old errored row is gone; the re-send inserted a NEW optimistic temp row (its POST fails
    // against the stub http and lands as an error bubble — the send pipeline itself is under
    // test elsewhere; here we only lock that the guard did NOT block a real retry).
    expect(raw.prepare("SELECT COUNT(*) c FROM messages WHERE guid='temp-old'").get()).toEqual({
      c: 0,
    });
    expect(res.tempGuid).not.toBe('temp-old');
    expect(
      raw.prepare('SELECT COUNT(*) c FROM messages WHERE guid = ?').get(res.tempGuid),
    ).toEqual({ c: 1 });
    expect(showToast).not.toHaveBeenCalled();
  });
});
