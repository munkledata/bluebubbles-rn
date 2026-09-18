import { sql } from 'drizzle-orm';
import type { AppDatabase } from '../types';

const MAX_DIAGNOSTIC_LEDGER_ROWS = 8_192;
const MAX_DIAGNOSTIC_WALLPAPER_PATHS = 8_192;

export type DownloadIntegrityCacheState = 'active' | 'reserved' | 'retiring';

/**
 * Private reconciliation material for the Download Integrity screen.
 *
 * Paths never leave the collector or appear in UI/log output. They are read only so the collector
 * can compare SQLCipher's ledger with the native fixed-root inventory before publishing aggregate
 * counts.
 */
export interface DownloadIntegrityLedgerEntry {
  readonly path: string;
  readonly bytes: number;
  readonly state: DownloadIntegrityCacheState;
}

export interface DownloadIntegrityDbCounts {
  readonly migrationCount: number;
  readonly migrationHead: string;
  readonly attachments: {
    readonly rows: number;
    readonly localPathRows: number;
    readonly distinctLocalPaths: number;
  };
  readonly cache: {
    readonly activeFiles: number;
    readonly activeBytes: number;
    readonly reservedFiles: number;
    readonly reservedBytes: number;
    readonly retiringFiles: number;
    readonly retiringBytes: number;
  };
  readonly receipts: {
    readonly pending: number;
    readonly completed: number;
    readonly terminal: number;
    readonly gallery: number;
    readonly album: number;
    readonly attempts0: number;
    readonly attempts1: number;
    readonly attempts2: number;
    readonly attempts3: number;
    readonly leased: number;
    readonly latestPresent: boolean;
    readonly latestPending: boolean;
    readonly latestCompleted: boolean;
    readonly latestTerminal: boolean;
    readonly latestGallery: boolean;
    readonly latestAlbum: boolean;
    readonly latestLeased: boolean;
    readonly latestAttempts: number;
    readonly latestHasLocalPath: boolean;
  };
  readonly wallpapers: {
    readonly channelRows: number;
    readonly localPathRows: number;
    readonly distinctLocalPaths: number;
    readonly channelWithoutLocalPath: number;
    readonly localPathWithoutChannel: number;
  };
}

export interface DownloadIntegrityDbSnapshot {
  readonly counts: DownloadIntegrityDbCounts;
  /** Bounded private material; the UI must never render this array. */
  readonly ledger: readonly DownloadIntegrityLedgerEntry[];
  /** Bounded private material used only for fixed-root native validation. */
  readonly wallpaperPaths: readonly string[];
}

interface CountsRow {
  migrationCount: unknown;
  migrationHead: unknown;
  attachmentRows: unknown;
  attachmentLocalPathRows: unknown;
  attachmentDistinctLocalPaths: unknown;
  cacheActiveFiles: unknown;
  cacheActiveBytes: unknown;
  cacheReservedFiles: unknown;
  cacheReservedBytes: unknown;
  cacheRetiringFiles: unknown;
  cacheRetiringBytes: unknown;
  receiptPending: unknown;
  receiptCompleted: unknown;
  receiptTerminal: unknown;
  receiptGallery: unknown;
  receiptAlbum: unknown;
  receiptAttempts0: unknown;
  receiptAttempts1: unknown;
  receiptAttempts2: unknown;
  receiptAttempts3: unknown;
  receiptLeased: unknown;
  latestReceiptPresent: unknown;
  latestReceiptPending: unknown;
  latestReceiptCompleted: unknown;
  latestReceiptTerminal: unknown;
  latestReceiptGallery: unknown;
  latestReceiptAlbum: unknown;
  latestReceiptLeased: unknown;
  latestReceiptAttempts: unknown;
  latestReceiptHasLocalPath: unknown;
  wallpaperChannelRows: unknown;
  wallpaperLocalPathRows: unknown;
  wallpaperDistinctLocalPaths: unknown;
  wallpaperChannelWithoutLocalPath: unknown;
  wallpaperLocalPathWithoutChannel: unknown;
}

interface LedgerRow {
  path: unknown;
  bytes: unknown;
  state: unknown;
}

function nonnegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Download integrity ${label} is invalid.`);
  }
  return value;
}

function booleanInteger(value: unknown, label: string): boolean {
  const parsed = nonnegativeSafeInteger(value, label);
  if (parsed !== 0 && parsed !== 1) {
    throw new Error(`Download integrity ${label} is not boolean.`);
  }
  return parsed === 1;
}

function migrationName(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    throw new Error('Download integrity migration head is invalid.');
  }
  return value;
}

function cacheState(value: unknown): DownloadIntegrityCacheState {
  if (value === 'active' || value === 'reserved' || value === 'retiring') return value;
  throw new Error('Download integrity cache state is invalid.');
}

/**
 * Read a bounded, privacy-preserving SQLCipher snapshot for native reconciliation.
 *
 * The aggregate row contains no identifiers. The second query is capped and its path values stay
 * inside the collector. A count mismatch means a writer landed between the two statements, so the
 * caller retries by taking its required before/after snapshots instead of presenting mixed state.
 */
export async function readDownloadIntegrityDbSnapshot(
  db: AppDatabase,
): Promise<DownloadIntegrityDbSnapshot> {
  const countRows = await db.all<CountsRow>(sql`
    WITH latest_receipt AS (
      SELECT attachment_guid, destination, state, attempts, lease_token
      FROM attachment_media_exports
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    )
    SELECT
      (SELECT COUNT(*) FROM _migrations) AS migrationCount,
      COALESCE((SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1), '') AS migrationHead,
      (SELECT COUNT(*) FROM attachments) AS attachmentRows,
      (SELECT COUNT(*) FROM attachments WHERE local_path IS NOT NULL) AS attachmentLocalPathRows,
      (SELECT COUNT(DISTINCT local_path) FROM attachments WHERE local_path IS NOT NULL)
        AS attachmentDistinctLocalPaths,
      (SELECT COUNT(*) FROM attachment_cache_entries WHERE state = 'active') AS cacheActiveFiles,
      COALESCE((SELECT SUM(bytes) FROM attachment_cache_entries WHERE state = 'active'), 0)
        AS cacheActiveBytes,
      (SELECT COUNT(*) FROM attachment_cache_entries WHERE state = 'reserved')
        AS cacheReservedFiles,
      COALESCE((SELECT SUM(bytes) FROM attachment_cache_entries WHERE state = 'reserved'), 0)
        AS cacheReservedBytes,
      (SELECT COUNT(*) FROM attachment_cache_entries WHERE state = 'retiring')
        AS cacheRetiringFiles,
      COALESCE((SELECT SUM(bytes) FROM attachment_cache_entries WHERE state = 'retiring'), 0)
        AS cacheRetiringBytes,
      (SELECT COUNT(*) FROM attachment_media_exports WHERE state = 'pending') AS receiptPending,
      (SELECT COUNT(*) FROM attachment_media_exports WHERE state = 'completed') AS receiptCompleted,
      (SELECT COUNT(*) FROM attachment_media_exports WHERE state = 'terminal') AS receiptTerminal,
      (SELECT COUNT(*) FROM attachment_media_exports WHERE destination = 'gallery') AS receiptGallery,
      (SELECT COUNT(*) FROM attachment_media_exports WHERE destination = 'album') AS receiptAlbum,
      (SELECT COUNT(*) FROM attachment_media_exports WHERE attempts = 0) AS receiptAttempts0,
      (SELECT COUNT(*) FROM attachment_media_exports WHERE attempts = 1) AS receiptAttempts1,
      (SELECT COUNT(*) FROM attachment_media_exports WHERE attempts = 2) AS receiptAttempts2,
      (SELECT COUNT(*) FROM attachment_media_exports WHERE attempts = 3) AS receiptAttempts3,
      (SELECT COUNT(*) FROM attachment_media_exports WHERE lease_token IS NOT NULL) AS receiptLeased,
      EXISTS(SELECT 1 FROM latest_receipt) AS latestReceiptPresent,
      EXISTS(SELECT 1 FROM latest_receipt WHERE state = 'pending') AS latestReceiptPending,
      EXISTS(SELECT 1 FROM latest_receipt WHERE state = 'completed') AS latestReceiptCompleted,
      EXISTS(SELECT 1 FROM latest_receipt WHERE state = 'terminal') AS latestReceiptTerminal,
      EXISTS(SELECT 1 FROM latest_receipt WHERE destination = 'gallery') AS latestReceiptGallery,
      EXISTS(SELECT 1 FROM latest_receipt WHERE destination = 'album') AS latestReceiptAlbum,
      EXISTS(SELECT 1 FROM latest_receipt WHERE lease_token IS NOT NULL) AS latestReceiptLeased,
      COALESCE((SELECT attempts FROM latest_receipt), 0) AS latestReceiptAttempts,
      EXISTS(
        SELECT 1
        FROM latest_receipt receipt
        JOIN attachments attachment ON attachment.guid = receipt.attachment_guid
        WHERE attachment.local_path IS NOT NULL
      ) AS latestReceiptHasLocalPath,
      (SELECT COUNT(*) FROM chats WHERE synced_background_channel IS NOT NULL)
        AS wallpaperChannelRows,
      (SELECT COUNT(*) FROM chats WHERE synced_background_uri IS NOT NULL)
        AS wallpaperLocalPathRows,
      (SELECT COUNT(DISTINCT synced_background_uri) FROM chats WHERE synced_background_uri IS NOT NULL)
        AS wallpaperDistinctLocalPaths,
      (SELECT COUNT(*) FROM chats
        WHERE synced_background_channel IS NOT NULL AND synced_background_uri IS NULL)
        AS wallpaperChannelWithoutLocalPath,
      (SELECT COUNT(*) FROM chats
        WHERE synced_background_channel IS NULL AND synced_background_uri IS NOT NULL)
        AS wallpaperLocalPathWithoutChannel
  `);
  const row = countRows[0];
  if (!row || countRows.length !== 1) {
    throw new Error('Download integrity aggregate snapshot is unavailable.');
  }

  const ledgerRows = await db.all<LedgerRow>(sql`
    SELECT path, bytes, state
    FROM attachment_cache_entries
    ORDER BY path ASC
    LIMIT ${MAX_DIAGNOSTIC_LEDGER_ROWS + 1}
  `);
  if (ledgerRows.length > MAX_DIAGNOSTIC_LEDGER_ROWS) {
    throw new Error('Download integrity ledger exceeds its bounded inspection limit.');
  }
  const ledger = ledgerRows.map((entry: LedgerRow): DownloadIntegrityLedgerEntry => {
    if (typeof entry.path !== 'string' || entry.path.length < 1 || entry.path.length > 4096) {
      throw new Error('Download integrity ledger path is invalid.');
    }
    return Object.freeze({
      path: entry.path,
      bytes: nonnegativeSafeInteger(entry.bytes, 'ledger bytes'),
      state: cacheState(entry.state),
    });
  });
  const wallpaperRows = await db.all<{ path: unknown }>(sql`
    SELECT DISTINCT synced_background_uri AS path
    FROM chats
    WHERE synced_background_uri IS NOT NULL
    ORDER BY synced_background_uri ASC
    LIMIT ${MAX_DIAGNOSTIC_WALLPAPER_PATHS + 1}
  `);
  if (wallpaperRows.length > MAX_DIAGNOSTIC_WALLPAPER_PATHS) {
    throw new Error('Download integrity wallpaper references exceed their inspection limit.');
  }
  const wallpaperPaths = wallpaperRows.map((entry: { path: unknown }) => {
    if (typeof entry.path !== 'string' || entry.path.length < 1 || entry.path.length > 4096) {
      throw new Error('Download integrity wallpaper path is invalid.');
    }
    return entry.path;
  });

  const counts: DownloadIntegrityDbCounts = Object.freeze({
    migrationCount: nonnegativeSafeInteger(row.migrationCount, 'migration count'),
    migrationHead: migrationName(row.migrationHead),
    attachments: Object.freeze({
      rows: nonnegativeSafeInteger(row.attachmentRows, 'attachment row count'),
      localPathRows: nonnegativeSafeInteger(
        row.attachmentLocalPathRows,
        'attachment local-path count',
      ),
      distinctLocalPaths: nonnegativeSafeInteger(
        row.attachmentDistinctLocalPaths,
        'distinct attachment local-path count',
      ),
    }),
    cache: Object.freeze({
      activeFiles: nonnegativeSafeInteger(row.cacheActiveFiles, 'active cache files'),
      activeBytes: nonnegativeSafeInteger(row.cacheActiveBytes, 'active cache bytes'),
      reservedFiles: nonnegativeSafeInteger(row.cacheReservedFiles, 'reserved cache files'),
      reservedBytes: nonnegativeSafeInteger(row.cacheReservedBytes, 'reserved cache bytes'),
      retiringFiles: nonnegativeSafeInteger(row.cacheRetiringFiles, 'retiring cache files'),
      retiringBytes: nonnegativeSafeInteger(row.cacheRetiringBytes, 'retiring cache bytes'),
    }),
    receipts: Object.freeze({
      pending: nonnegativeSafeInteger(row.receiptPending, 'pending receipt count'),
      completed: nonnegativeSafeInteger(row.receiptCompleted, 'completed receipt count'),
      terminal: nonnegativeSafeInteger(row.receiptTerminal, 'terminal receipt count'),
      gallery: nonnegativeSafeInteger(row.receiptGallery, 'gallery receipt count'),
      album: nonnegativeSafeInteger(row.receiptAlbum, 'album receipt count'),
      attempts0: nonnegativeSafeInteger(row.receiptAttempts0, 'zero-attempt receipt count'),
      attempts1: nonnegativeSafeInteger(row.receiptAttempts1, 'one-attempt receipt count'),
      attempts2: nonnegativeSafeInteger(row.receiptAttempts2, 'two-attempt receipt count'),
      attempts3: nonnegativeSafeInteger(row.receiptAttempts3, 'three-attempt receipt count'),
      leased: nonnegativeSafeInteger(row.receiptLeased, 'leased receipt count'),
      latestPresent: booleanInteger(row.latestReceiptPresent, 'latest receipt presence'),
      latestPending: booleanInteger(row.latestReceiptPending, 'latest receipt pending state'),
      latestCompleted: booleanInteger(row.latestReceiptCompleted, 'latest receipt completed state'),
      latestTerminal: booleanInteger(row.latestReceiptTerminal, 'latest receipt terminal state'),
      latestGallery: booleanInteger(row.latestReceiptGallery, 'latest receipt gallery destination'),
      latestAlbum: booleanInteger(row.latestReceiptAlbum, 'latest receipt album destination'),
      latestLeased: booleanInteger(row.latestReceiptLeased, 'latest receipt lease state'),
      latestAttempts: nonnegativeSafeInteger(row.latestReceiptAttempts, 'latest receipt attempts'),
      latestHasLocalPath: booleanInteger(
        row.latestReceiptHasLocalPath,
        'latest receipt local-path state',
      ),
    }),
    wallpapers: Object.freeze({
      channelRows: nonnegativeSafeInteger(row.wallpaperChannelRows, 'wallpaper channel rows'),
      localPathRows: nonnegativeSafeInteger(
        row.wallpaperLocalPathRows,
        'wallpaper local-path rows',
      ),
      distinctLocalPaths: nonnegativeSafeInteger(
        row.wallpaperDistinctLocalPaths,
        'distinct wallpaper local-path count',
      ),
      channelWithoutLocalPath: nonnegativeSafeInteger(
        row.wallpaperChannelWithoutLocalPath,
        'wallpaper channel without local path count',
      ),
      localPathWithoutChannel: nonnegativeSafeInteger(
        row.wallpaperLocalPathWithoutChannel,
        'wallpaper local path without channel count',
      ),
    }),
  });

  const countedLedgerFiles =
    counts.cache.activeFiles + counts.cache.reservedFiles + counts.cache.retiringFiles;
  if (countedLedgerFiles !== ledger.length) {
    throw new Error('Download integrity database changed during its bounded snapshot.');
  }
  if (counts.wallpapers.distinctLocalPaths !== wallpaperPaths.length) {
    throw new Error('Download integrity database changed during wallpaper inspection.');
  }

  return Object.freeze({
    counts,
    ledger: Object.freeze(ledger),
    wallpaperPaths: Object.freeze(wallpaperPaths),
  });
}
