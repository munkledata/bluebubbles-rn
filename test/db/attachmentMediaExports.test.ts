import {
  ATTACHMENT_MEDIA_EXPORT_MAX_PENDING_AGE_MS,
  cancelPendingAttachmentMediaExportsWithinTransaction,
  claimAttachmentCachePathsForRetirement,
  claimNextAttachmentMediaExport,
  completeAttachmentMediaExport,
  enqueueAttachmentMediaExport,
  failAttachmentMediaExport,
  getAttachmentCacheQuotaSnapshot,
  maintainAttachmentMediaExports,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

const NOW = 1_800_000_000_000;
const PATH = 'file:///documents/attachments/auto/photo.jpg';

function seedEligibleImage(
  raw: import('better-sqlite3').Database,
  guid: string,
): { attachmentId: number } {
  raw.prepare("INSERT OR IGNORE INTO chats (guid) VALUES ('media-export-chat')").run();
  const chat = raw.prepare("SELECT id FROM chats WHERE guid = 'media-export-chat'").get() as {
    id: number;
  };
  raw
    .prepare('INSERT INTO messages (guid, chat_id, date_created) VALUES (?, ?, ?)')
    .run(`message-${guid}`, chat.id, NOW);
  const message = raw.prepare('SELECT id FROM messages WHERE guid = ?').get(`message-${guid}`) as {
    id: number;
  };
  const inserted = raw
    .prepare(
      `INSERT INTO attachments (guid, message_id, mime_type, total_bytes)
       VALUES (?, ?, 'image/jpeg', 1024)
       RETURNING id`,
    )
    .get(guid, message.id) as { id: number };
  return { attachmentId: inserted.id };
}

async function makeDownloadClaim(db: AppDatabase, raw: import('better-sqlite3').Database) {
  seedEligibleImage(raw, 'attachment-claim');
  await enqueueAttachmentMediaExport(
    db,
    { attachmentGuid: 'attachment-claim', destination: 'album' },
    () => true,
    () => NOW,
  );
  raw.prepare('UPDATE attachments SET local_path = ? WHERE guid = ?').run(PATH, 'attachment-claim');
  raw
    .prepare(
      `INSERT INTO attachment_cache_entries
         (path, bytes, last_used_at, state, attempts, next_retry_at)
       VALUES (?, 1024, ?, 'active', 0, 0)`,
    )
    .run(PATH, NOW);
  return claimNextAttachmentMediaExport(
    db,
    { leaseToken: 'worker-one', destination: 'album', clock: () => NOW + 1 },
    () => true,
  );
}

describe('attachment media export receipts', () => {
  it('persists intent before local_path and completes only the exact fenced claim', async () => {
    const { db, raw } = await createTestDb();
    const claim = await makeDownloadClaim(db, raw);

    expect(claim).toMatchObject({
      attachmentGuid: 'attachment-claim',
      destination: 'album',
      localPath: PATH,
      attempts: 1,
      claimVersion: 1,
      leaseToken: 'worker-one',
    });
    expect(
      await completeAttachmentMediaExport(
        db,
        { id: claim!.id, claimVersion: claim!.claimVersion + 1, leaseToken: claim!.leaseToken },
        () => true,
        () => NOW + 2,
      ),
    ).toBe(false);
    expect(
      await completeAttachmentMediaExport(
        db,
        claim!,
        () => true,
        () => NOW + 2,
      ),
    ).toBe(true);
    expect(
      raw
        .prepare(
          `SELECT state, attempts, terminal_at AS terminalAt, last_error_code AS lastErrorCode
             FROM attachment_media_exports WHERE id = ?`,
        )
        .get(claim!.id),
    ).toEqual({ state: 'completed', attempts: 1, terminalAt: NOW + 2, lastErrorCode: null });
  });

  it('deduplicates one attachment and atomically cancels pending work on policy revocation', async () => {
    const { db, raw } = await createTestDb();
    seedEligibleImage(raw, 'attachment-dedupe');

    await expect(
      enqueueAttachmentMediaExport(
        db,
        { attachmentGuid: 'attachment-dedupe', destination: 'gallery' },
        () => true,
        () => NOW,
      ),
    ).resolves.toMatchObject({ status: 'enqueued' });
    await expect(
      enqueueAttachmentMediaExport(
        db,
        { attachmentGuid: 'attachment-dedupe', destination: 'gallery' },
        () => true,
        () => NOW + 1,
      ),
    ).resolves.toMatchObject({ status: 'duplicate', state: 'pending' });

    await withDbTransaction(db, (context) =>
      cancelPendingAttachmentMediaExportsWithinTransaction(context),
    );
    expect(raw.prepare('SELECT COUNT(*) AS rows FROM attachment_media_exports').get()).toEqual({
      rows: 0,
    });
  });

  it('schedules bounded retry and expires old or now-ineligible receipts without native work', async () => {
    const { db, raw } = await createTestDb();
    const claim = await makeDownloadClaim(db, raw);
    const failure = await failAttachmentMediaExport(
      db,
      claim!,
      'native-error',
      () => true,
      () => NOW + 10,
    );
    expect(failure).toEqual({
      status: 'retry-scheduled',
      attempts: 1,
      nextAttemptAt: NOW + 30_010,
    });

    await maintainAttachmentMediaExports(
      db,
      () => true,
      () => NOW + ATTACHMENT_MEDIA_EXPORT_MAX_PENDING_AGE_MS,
    );
    expect(
      raw
        .prepare(
          `SELECT state, last_error_code AS lastErrorCode
             FROM attachment_media_exports WHERE id = ?`,
        )
        .get(claim!.id),
    ).toEqual({ state: 'terminal', lastErrorCode: 'expired' });
  });
});

/**
 * A Photos export must keep its source file in the attachment cache until it is saved or gives up
 * (review M081). The protection reads SQLite's own clock, so these times are relative to the real
 * one rather than to NOW above.
 */
describe('attachment media export cache protection', () => {
  const HOUR = 60 * 60_000;

  async function seedCachedExport(receipt: {
    createdAt: number;
    expiresAt: number;
    attempts: number;
    leaseExpiresAt: number | null;
  }) {
    const { db, raw } = await createTestDb();
    seedEligibleImage(raw, 'cached-export');
    raw.prepare('UPDATE attachments SET local_path = ? WHERE guid = ?').run(PATH, 'cached-export');
    raw
      .prepare(
        `INSERT INTO attachment_cache_entries
           (path, bytes, last_used_at, state, attempts, next_retry_at)
         VALUES (?, 1024, 1, 'active', 0, 0)`,
      )
      .run(PATH);
    raw
      .prepare(
        `INSERT INTO attachment_media_exports
           (attachment_guid, destination, created_at, expires_at, attempts,
            lease_token, lease_expires_at)
         VALUES ('cached-export', 'gallery', ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.createdAt,
        receipt.expiresAt,
        receipt.attempts,
        receipt.leaseExpiresAt === null ? null : 'worker-lease',
        receipt.leaseExpiresAt ?? 0,
      );
    return db;
  }

  const wall = Date.now();
  const unexpired = { createdAt: wall - HOUR, expiresAt: wall + HOUR };
  const expired = { createdAt: wall - 2 * HOUR, expiresAt: wall - HOUR };

  it.each([
    [
      'a pending receipt before it expires',
      true,
      { ...unexpired, attempts: 0, leaseExpiresAt: null },
    ],
    ['a receipt past its expiry', false, { ...expired, attempts: 0, leaseExpiresAt: null }],
    ['a receipt out of attempts', false, { ...unexpired, attempts: 3, leaseExpiresAt: null }],
    [
      'a live save attempt after expiry',
      true,
      { ...expired, attempts: 3, leaseExpiresAt: wall + HOUR },
    ],
    [
      'a save attempt whose lease ran out',
      false,
      { ...expired, attempts: 3, leaseExpiresAt: wall - HOUR },
    ],
  ])('%s: protects the cached file = %s', async (_label, protects, receipt) => {
    const db = await seedCachedExport(receipt);

    const snapshot = await getAttachmentCacheQuotaSnapshot(db);
    expect(snapshot.candidates.map((candidate) => candidate.path)).toEqual(protects ? [] : [PATH]);

    const claim = await withDbTransaction(db, (context) =>
      claimAttachmentCachePathsForRetirement(context, [PATH]),
    );
    expect(claim).toEqual(
      protects
        ? { status: 'refused', reason: 'media_export_protected', paths: [PATH] }
        : { status: 'claimed', paths: [PATH], clearedReferences: 1 },
    );
  });
});
