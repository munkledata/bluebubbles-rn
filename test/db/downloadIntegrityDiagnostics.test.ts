import { MIGRATIONS } from '../../src/db/migrations';
import { readDownloadIntegrityDbSnapshot } from '../../src/db/repositories/downloadIntegrityDiagnostics';
import { createTestDb } from '../support/testDb';

it('returns a bounded aggregate snapshot while keeping reconciliation paths private', async () => {
  const { db, raw } = await createTestDb();
  raw.exec(`
    BEGIN;
    INSERT INTO chats (guid, synced_background_channel, synced_background_uri) VALUES
      ('wall-current', 'channel-1', 'file:///wall/current.jpg'),
      ('wall-channel-only', 'channel-2', NULL),
      ('wall-uri-only', NULL, 'file:///wall/orphan.jpg'),
      ('wall-duplicate', 'channel-3', 'file:///wall/current.jpg');
    INSERT INTO attachments (guid, local_path) VALUES
      ('att-pending0', NULL),
      ('att-latest-leased', 'file:///cache/active'),
      ('att-completed', 'file:///cache/shared'),
      ('att-terminal', 'file:///cache/shared');
    INSERT INTO attachment_cache_entries
      (path, bytes, last_used_at, state, attempts, next_retry_at) VALUES
      ('file:///cache/active', 11, 1, 'active', 0, 0),
      ('file:///cache/reserved', 22, 2, 'reserved', 0, 0),
      ('file:///cache/retiring', 33, 3, 'retiring', 1, 4);
    INSERT INTO attachment_media_exports
      (attachment_guid, destination, state, created_at, expires_at, attempts, claim_version,
       next_attempt_at, lease_token, lease_expires_at, terminal_at, last_error_code) VALUES
      ('att-pending0', 'gallery', 'pending', 100, 1100, 0, 0, 0, NULL, 0, NULL, NULL),
      ('att-completed', 'album', 'completed', 200, 1200, 2, 2, 0, NULL, 0, 200, NULL),
      ('att-terminal', 'gallery', 'terminal', 300, 1300, 3, 3, 0, NULL, 0, 300,
       'attempt-cap'),
      ('att-latest-leased', 'album', 'pending', 400, 1400, 1, 1, 401, 'lease-1', 500,
       NULL, NULL);
    COMMIT;
  `);

  const result = await readDownloadIntegrityDbSnapshot(db);

  expect(result.counts).toEqual({
    migrationCount: MIGRATIONS.length,
    migrationHead: MIGRATIONS.at(-1)?.name,
    attachments: { rows: 4, localPathRows: 3, distinctLocalPaths: 2 },
    cache: {
      activeFiles: 1,
      activeBytes: 11,
      reservedFiles: 1,
      reservedBytes: 22,
      retiringFiles: 1,
      retiringBytes: 33,
    },
    receipts: {
      pending: 2,
      completed: 1,
      terminal: 1,
      gallery: 2,
      album: 2,
      attempts0: 1,
      attempts1: 1,
      attempts2: 1,
      attempts3: 1,
      leased: 1,
      latestPresent: true,
      latestPending: true,
      latestCompleted: false,
      latestTerminal: false,
      latestGallery: false,
      latestAlbum: true,
      latestLeased: true,
      latestAttempts: 1,
      latestHasLocalPath: true,
    },
    wallpapers: {
      channelRows: 3,
      localPathRows: 3,
      distinctLocalPaths: 2,
      channelWithoutLocalPath: 1,
      localPathWithoutChannel: 1,
    },
  });
  expect(result.ledger).toEqual([
    { path: 'file:///cache/active', bytes: 11, state: 'active' },
    { path: 'file:///cache/reserved', bytes: 22, state: 'reserved' },
    { path: 'file:///cache/retiring', bytes: 33, state: 'retiring' },
  ]);
  expect(result.wallpaperPaths).toEqual(['file:///wall/current.jpg', 'file:///wall/orphan.jpg']);
});
