import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import { Chat } from '@core/models';
import { logger } from '@core/secure';
import { ClientErrorCode, sendErrorCode } from '@utils';
import {
  getChatIdByGuid,
  insertOutgoingText,
  markMessageDeleted,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import { DbCommitGuardRejectedError } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { clearFailedSendNotice, notifyFailedSend } from '@/services/send/sendFailureNotice';
import { handleSendFailure, reconcileSendOutcome } from '@/services/send/sendOutcome';
import { createTestDb } from '../support/testDb';

jest.mock('@/services/send/sendFailureNotice', () => ({
  clearFailedSendNotice: jest.fn(async () => undefined),
  notifyFailedSend: jest.fn(async () => undefined),
}));

const mockClearFailedSendNotice = clearFailedSendNotice as jest.Mock;
const mockNotifyFailedSend = notifyFailedSend as jest.Mock;

beforeEach(() => {
  mockClearFailedSendNotice.mockClear();
  mockNotifyFailedSend.mockClear();
});

async function seedOutgoing(db: AppDatabase, tempGuid: string, now: number): Promise<void> {
  const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
  await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: [{ address: 'a@b.com' }] })],
    handles,
  );
  const chatId = await getChatIdByGuid(db, 'c1');
  await insertOutgoingText(db, { tempGuid, chatId: chatId!, chatGuid: 'c1', text: 'hi', now });
}

const msgRow = (raw: Database.Database, guid: string) =>
  raw
    .prepare('SELECT guid, send_state s, error e, error_message d FROM messages WHERE guid = ?')
    .get(guid) as { guid: string; s: string; e: number; d: string | null } | undefined;
const msgCount = (raw: Database.Database): number =>
  (raw.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c;
const queueCount = (raw: Database.Database): number =>
  (raw.prepare('SELECT COUNT(*) c FROM outgoing_queue').get() as { c: number }).c;
const aliasTarget = (raw: Database.Database, aliasGuid: string): string | undefined =>
  (
    raw
      .prepare(
        'SELECT canonical_guid AS canonicalGuid FROM message_guid_aliases WHERE alias_guid=?',
      )
      .get(aliasGuid) as { canonicalGuid: string } | undefined
  )?.canonicalGuid;
const ledgerDate = (raw: Database.Database, guid: string): number | undefined =>
  (
    raw
      .prepare('SELECT date_deleted AS dateDeleted FROM message_deletion_ledger WHERE guid=?')
      .get(guid) as { dateDeleted: number } | undefined
  )?.dateDeleted;

describe('reconcileSendOutcome', () => {
  it('promotes temp→real and clears the queue when the ack carries a guid', async () => {
    const { db, raw } = await createTestDb();
    await seedOutgoing(db, 'temp-aaaa0000', 1000);
    raw
      .prepare("UPDATE messages SET error_message = 'stale detail' WHERE guid = 'temp-aaaa0000'")
      .run();
    await reconcileSendOutcome(db, 'temp-aaaa0000', { guid: 'real-1' }, 1000);
    expect(msgCount(raw)).toBe(1);
    expect(msgRow(raw, 'real-1')?.s).toBe('sent');
    expect(msgRow(raw, 'real-1')?.d).toBeNull();
    expect(queueCount(raw)).toBe(0);
    expect(mockClearFailedSendNotice).toHaveBeenCalledWith(db, 'real-1', undefined);
  });

  it('marks sent-no-guid (row keeps its temp guid) when the ack has NO guid', async () => {
    const { db, raw } = await createTestDb();
    await seedOutgoing(db, 'temp-bbbb0000', 1000);
    raw
      .prepare("UPDATE messages SET error_message = 'stale detail' WHERE guid = 'temp-bbbb0000'")
      .run();
    await reconcileSendOutcome(db, 'temp-bbbb0000', {}, 1000);
    expect(msgCount(raw)).toBe(1);
    expect(msgRow(raw, 'temp-bbbb0000')?.s).toBe('sent');
    expect(msgRow(raw, 'temp-bbbb0000')?.d).toBeNull();
    expect(queueCount(raw)).toBe(0);
    expect(mockClearFailedSendNotice).toHaveBeenCalledWith(db, 'temp-bbbb0000', undefined);
  });

  it('rolls back an absent-guid ack when its commit guard is revoked mid-update', async () => {
    const { db, raw } = await createTestDb();
    const tempGuid = 'temp-no-guid-guard-revoked';
    await seedOutgoing(db, tempGuid, 1000);
    let current = true;
    let triggerRan = false;
    raw.function('revoke_absent_guid_ack_guard', () => {
      triggerRan = true;
      current = false;
      return 1;
    });
    raw.exec(`
      CREATE TRIGGER revoke_absent_guid_ack_guard
      AFTER UPDATE OF send_state ON messages
      WHEN OLD.guid = '${tempGuid}' AND NEW.send_state = 'sent'
      BEGIN
        SELECT revoke_absent_guid_ack_guard();
      END
    `);

    await expect(
      reconcileSendOutcome(db, tempGuid, {}, 1000, () => current),
    ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);

    expect(triggerRan).toBe(true);
    expect(msgRow(raw, tempGuid)?.s).toBe('sending');
    expect(queueCount(raw)).toBe(1);
    expect(mockClearFailedSendNotice).not.toHaveBeenCalled();

    raw.exec('DROP TRIGGER revoke_absent_guid_ack_guard');
    current = true;
    await expect(
      reconcileSendOutcome(db, tempGuid, {}, 1000, () => current),
    ).resolves.toBeUndefined();
    expect(msgRow(raw, tempGuid)?.s).toBe('sent');
    expect(queueCount(raw)).toBe(0);
    expect(mockClearFailedSendNotice).toHaveBeenCalledWith(db, tempGuid, expect.any(Function));
  });

  it('rolls back a real-guid promotion when its commit guard is revoked mid-owner', async () => {
    const { db, raw } = await createTestDb();
    const tempGuid = 'temp-real-guid-guard-revoked';
    const realGuid = 'real-guid-after-retry';
    await seedOutgoing(db, tempGuid, 1000);
    await markMessageDeleted(db, tempGuid, 900);
    let current = true;
    let triggerRan = false;
    raw.function('revoke_real_guid_ack_guard', () => {
      triggerRan = true;
      current = false;
      return 1;
    });
    raw.exec(`
      CREATE TRIGGER revoke_real_guid_ack_guard
      AFTER UPDATE OF guid ON messages
      WHEN OLD.guid = '${tempGuid}' AND NEW.guid = '${realGuid}'
      BEGIN
        SELECT revoke_real_guid_ack_guard();
      END
    `);

    await expect(
      reconcileSendOutcome(db, tempGuid, { guid: realGuid }, 1000, () => current),
    ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);

    expect(triggerRan).toBe(true);
    expect(msgRow(raw, tempGuid)?.s).toBe('sending');
    expect(msgRow(raw, realGuid)).toBeUndefined();
    expect(aliasTarget(raw, tempGuid)).toBeUndefined();
    expect(ledgerDate(raw, tempGuid)).toBe(900);
    expect(ledgerDate(raw, realGuid)).toBeUndefined();
    expect(queueCount(raw)).toBe(1);
    expect(mockClearFailedSendNotice).not.toHaveBeenCalled();

    raw.exec('DROP TRIGGER revoke_real_guid_ack_guard');
    current = true;
    await expect(
      reconcileSendOutcome(db, tempGuid, { guid: realGuid }, 1000, () => current),
    ).resolves.toBeUndefined();
    expect(msgRow(raw, tempGuid)).toBeUndefined();
    expect(msgRow(raw, realGuid)?.s).toBe('sent');
    expect(aliasTarget(raw, tempGuid)).toBe(realGuid);
    expect(ledgerDate(raw, tempGuid)).toBeUndefined();
    expect(ledgerDate(raw, realGuid)).toBe(900);
    expect(queueCount(raw)).toBe(0);
    expect(mockClearFailedSendNotice).toHaveBeenCalledWith(db, realGuid, expect.any(Function));
  });

  it('treats an RCS ack echoing our OWN tempGuid as guid-absent (row survives)', async () => {
    const { db, raw } = await createTestDb();
    await seedOutgoing(db, 'temp-cccc0000', 1000);
    await reconcileSendOutcome(db, 'temp-cccc0000', { guid: 'temp-cccc0000' }, 1000);
    // NOT promoted/deleted — flipped to 'sent' under the temp guid, queue cleared,
    // leaving the live `new-message` fanout to reconcile the real rcs-<id> by content.
    expect(msgCount(raw)).toBe(1);
    expect(msgRow(raw, 'temp-cccc0000')?.s).toBe('sent');
    expect(queueCount(raw)).toBe(0);
    expect(mockClearFailedSendNotice).toHaveBeenCalledWith(db, 'temp-cccc0000', undefined);
  });
});

describe('handleSendFailure', () => {
  afterEach(() => jest.restoreAllMocks());

  it('logs the rich diagnostic (code + HTTP status + message) and errors the row', async () => {
    const { db, raw } = await createTestDb();
    await seedOutgoing(db, 'temp-dddd0000', 1000);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await handleSendFailure(
      db,
      'temp-dddd0000',
      new ApiError('unauthorized', 'nope', 401),
      'send',
      'c1',
    );
    expect(warn).toHaveBeenCalledWith('[send] failed for chat c1 (code 401, HTTP 401): nope');
    const row = msgRow(raw, 'temp-dddd0000');
    expect(row?.s).toBe('error');
    expect(row?.e).toBe(401);
    expect(
      (raw.prepare('SELECT attempts FROM outgoing_queue').get() as { attempts: number }).attempts,
    ).toBe(1);
    expect(mockNotifyFailedSend).toHaveBeenCalledWith(db, 'c1', 'temp-dddd0000', undefined);
  });

  it('persists sanitized server detail without adding it to the diagnostic log', async () => {
    const { db, raw } = await createTestDb();
    await seedOutgoing(db, 'temp-detail0000', 1000);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const detail = 'Messages rejected this send for the selected recipient.';

    await handleSendFailure(
      db,
      'temp-detail0000',
      ApiError.fromStatus(422, 'POST /message/text failed', detail),
      'send',
      'c1',
    );

    expect(msgRow(raw, 'temp-detail0000')?.d).toBe(detail);
    expect(warn).toHaveBeenCalledWith(
      '[send] failed for chat c1 (code 422, HTTP 422): POST /message/text failed',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(detail);
    expect(mockNotifyFailedSend).toHaveBeenCalledWith(db, 'c1', 'temp-detail0000', undefined);
    expect(mockNotifyFailedSend.mock.calls[0]?.slice(1)).not.toContain(detail);
  });

  it('maps a local-file ApiError to "Attachment Unavailable", NOT the connection code', async () => {
    // Both are status-less, so without the explicit kind check they'd collapse to the same
    // "Connection Refused" bubble — blaming the server for a file problem on this device.
    const { db, raw } = await createTestDb();
    await seedOutgoing(db, 'temp-ffff0000', 1000);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await handleSendFailure(
      db,
      'temp-ffff0000',
      new ApiError('local_file', 'Attachment file is no longer available'),
      'send-attachment',
      'c1',
    );
    expect(msgRow(raw, 'temp-ffff0000')?.e).toBe(ClientErrorCode.attachmentUnreadable);
    expect(msgRow(raw, 'temp-ffff0000')?.e).not.toBe(ClientErrorCode.connectionRefused);
  });

  it('maps a client-side timeout to "Network Timed Out", not "Connection Refused"', async () => {
    const { db, raw } = await createTestDb();
    await seedOutgoing(db, 'temp-timeout0000', 1000);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await handleSendFailure(
      db,
      'temp-timeout0000',
      new ApiError('timeout', 'Attachment retry timed out'),
      'queue',
      'c1',
    );

    expect(msgRow(raw, 'temp-timeout0000')?.e).toBe(ClientErrorCode.gatewayTimeout);
    expect(msgRow(raw, 'temp-timeout0000')?.e).not.toBe(ClientErrorCode.connectionRefused);
  });

  it('maps a non-HTTP throw to the connection error code (no HTTP part in the log)', async () => {
    const { db, raw } = await createTestDb();
    await seedOutgoing(db, 'temp-eeee0000', 1000);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await handleSendFailure(db, 'temp-eeee0000', new Error('boom'), 'queue', 'c1', 5000);
    const code = sendErrorCode(null);
    expect(warn).toHaveBeenCalledWith(`[queue] failed for chat c1 (code ${code}): boom`);
    expect(msgRow(raw, 'temp-eeee0000')?.e).toBe(code);
    // The explicit `now` seeds the backoff (first retry = now + 30s).
    expect(
      (raw.prepare('SELECT next_retry_at n FROM outgoing_queue').get() as { n: number }).n,
    ).toBe(5000 + 30_000);
  });

  it('does not post a failure notice when no durable outgoing row was reconciled', async () => {
    const { db, raw } = await createTestDb();
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await handleSendFailure(db, 'temp-missing0000', new Error('gone'), 'queue', 'c1', 5000);

    expect(msgCount(raw)).toBe(0);
    expect(mockNotifyFailedSend).not.toHaveBeenCalled();
  });
});
