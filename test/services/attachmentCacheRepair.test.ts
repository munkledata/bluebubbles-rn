import { getAttachmentCacheEntry } from '@db/repositories';
import type { AttachmentCacheScanFile } from '@native/boundedDownload';
import {
  AttachmentCacheCoordinator,
  type AttachmentCacheNativeBoundary,
} from '@/services/download/attachmentCacheCoordinator';
import {
  invalidateAttachmentCacheRecoveryReadiness,
  isAttachmentCacheRecoveryReady,
  recoverAttachmentCache,
  repairAttachmentCache,
  type AttachmentCacheRepairProgress,
} from '@/services/download/attachmentCacheRecovery';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { createTestDb } from '../support/testDb';

// Review item 888: an old cache over the startup scan's 8,192 files failed recovery on every
// launch, so downloads never turned back on. Storage → Repair Downloads reads it in pages and lets
// the ordinary cleanup bring it back within limits, then reruns recovery.

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 30 * DAY_MS;
const MIB = 1024 * 1024;
// Stands in for the native startup scan's 8,192-file total.
const STARTUP_SCAN_LIMIT = 3;
const legacy = (name: string): string => `file:///data/app/files/attachments/${name}/${name}.jpg`;
type TestDatabase = Awaited<ReturnType<typeof createTestDb>>['raw'];
type RepairScan = (
  onPage: (files: readonly AttachmentCacheScanFile[]) => Promise<void>,
  shouldContinue: () => boolean,
) => Promise<void>;

function lease(generation = 7): RealtimeDeliveryLease & { revoke(): void } {
  let current = true;
  return {
    generation,
    isCurrent: () => current,
    revoke: () => {
      current = false;
    },
  };
}

/** The phone's old download folder: path → bytes and modified time. */
class FakeCache {
  readonly files = new Map<string, { bytes: number; mtimeMs: number }>();
  readonly io: AttachmentCacheNativeBoundary = {
    getAvailableBytes: jest.fn(async () => 4 * 1024 * MIB),
    statFile: jest.fn(async (path: string) => ({
      exists: this.files.has(path),
      bytes: this.files.get(path)?.bytes ?? 0,
    })),
    deleteFile: jest.fn(async (path: string) => {
      const bytes = this.files.get(path)?.bytes ?? 0;
      const found = this.files.delete(path);
      return { status: found ? ('deleted' as const) : ('missing' as const), bytes };
    }),
  };

  add(path: string, bytes: number, mtimeMs: number): void {
    this.files.set(path, { bytes, mtimeMs });
  }

  /** A repair scan in pages of `pageSize`, cancelled the way the native bridge is. */
  repairScan(pageSize: number): jest.MockedFunction<RepairScan> {
    return jest.fn<Promise<void>, Parameters<RepairScan>>(async (onPage, shouldContinue) => {
      const listing = [...this.files.keys()];
      for (let offset = 0; offset < listing.length; offset += pageSize) {
        if (!shouldContinue()) throw new Error('cancelled');
        const page = listing.slice(offset, offset + pageSize).flatMap((uri) => {
          const file = this.files.get(uri);
          return file ? [{ uri, bytes: file.bytes, mtimeMs: file.mtimeMs }] : [];
        });
        if (page.length > 0) await onPage(page);
      }
    });
  }

  /** Like the native startup scan: whatever is left on disk, or an overflow above its total. */
  readonly startupScan = jest.fn(async (): Promise<AttachmentCacheScanFile[]> => {
    if (this.files.size > STARTUP_SCAN_LIMIT) {
      throw new Error('Attachment cache scan overflow: the cache contains too many files');
    }
    return [...this.files].map(([uri, file]) => ({
      uri,
      bytes: file.bytes,
      mtimeMs: file.mtimeMs,
    }));
  });
}

function seedReference(raw: TestDatabase, guid: string, path: string): void {
  raw.prepare(`INSERT INTO attachments (guid, local_path) VALUES (?, ?)`).run(guid, path);
}

function localPath(raw: TestDatabase, guid: string): string | null {
  const row = raw.prepare(`SELECT local_path AS path FROM attachments WHERE guid = ?`).get(guid) as
    { path: string | null } | undefined;
  return row?.path ?? null;
}

/** Five 600 MiB legacy downloads, oldest first; together they exceed the 2 GiB limit. */
function seedOversizedLegacyCache(cache: FakeCache, raw: TestDatabase): void {
  ['a', 'b', 'c', 'd', 'e'].forEach((name, index) => {
    cache.add(legacy(name), 600 * MIB, DAY_MS + index);
    seedReference(raw, `att-${name}`, legacy(name));
  });
}

beforeEach(() => {
  invalidateAttachmentCacheRecoveryReadiness();
  resumeRealtimeDeliveries();
});

afterEach(async () => {
  await pauseRealtimeDeliveries();
  resumeRealtimeDeliveries();
});

it('deletes only the oldest files beyond the limits, offers their downloads again, and reopens downloads', async () => {
  const { db, raw } = await createTestDb();
  const cache = new FakeCache();
  seedOversizedLegacyCache(cache, raw);
  const currentLease = lease();
  const progress: AttachmentCacheRepairProgress[] = [];
  await expect(
    recoverAttachmentCache(db, currentLease, {
      scan: cache.startupScan,
      coordinator: new AttachmentCacheCoordinator(cache.io, () => NOW),
      now: () => NOW,
    }),
  ).rejects.toThrow('overflow');

  const result = await repairAttachmentCache(db, currentLease, {
    scanForRepair: cache.repairScan(2),
    scan: cache.startupScan,
    coordinator: new AttachmentCacheCoordinator(cache.io, () => NOW),
    now: () => NOW,
    onProgress: (step) => progress.push(step),
  });

  expect(result).toEqual({
    status: 'repaired',
    checkedFiles: 5,
    removedFiles: 2,
    withinQuota: true,
  });
  expect([...cache.files.keys()]).toEqual([legacy('c'), legacy('d'), legacy('e')]);
  expect(localPath(raw, 'att-a')).toBeNull();
  expect(localPath(raw, 'att-b')).toBeNull();
  expect(localPath(raw, 'att-e')).toBe(legacy('e'));
  expect(await getAttachmentCacheEntry(db, legacy('e'))).toMatchObject({ state: 'active' });
  expect(progress.map((step) => step.checkedFiles)).toEqual([2, 4, 5]);
  expect(isAttachmentCacheRecoveryReady(currentLease)).toBe(true);
});

it('keeps an old file that an unsent message still needs, even when it is the oldest', async () => {
  const { db, raw } = await createTestDb();
  const cache = new FakeCache();
  seedOversizedLegacyCache(cache, raw);
  raw
    .prepare(
      `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
       VALUES ('temp-unsent', 'chat', 'attachment', ?)`,
    )
    .run(JSON.stringify({ attachmentGuid: 'att-a', localPath: legacy('a') }));
  const currentLease = lease();

  const result = await repairAttachmentCache(db, currentLease, {
    scanForRepair: cache.repairScan(2),
    scan: cache.startupScan,
    coordinator: new AttachmentCacheCoordinator(cache.io, () => NOW),
    now: () => NOW,
  });

  expect(result).toMatchObject({ status: 'repaired', removedFiles: 2 });
  expect(cache.files.has(legacy('a'))).toBe(true);
  expect(localPath(raw, 'att-a')).toBe(legacy('a'));
  expect(cache.io.deleteFile).not.toHaveBeenCalledWith(legacy('a'));
  expect(isAttachmentCacheRecoveryReady(currentLease)).toBe(true);
});

it('leaves a cache whose startup check already succeeded alone', async () => {
  const { db } = await createTestDb();
  const cache = new FakeCache();
  const currentLease = lease();
  const coordinator = new AttachmentCacheCoordinator(cache.io, () => NOW);
  await recoverAttachmentCache(db, currentLease, {
    scan: cache.startupScan,
    coordinator,
    now: () => NOW,
  });
  const scanForRepair = cache.repairScan(2);

  await expect(
    repairAttachmentCache(db, currentLease, { scanForRepair, coordinator, now: () => NOW }),
  ).resolves.toEqual({ status: 'not-needed' });
  expect(scanForRepair).not.toHaveBeenCalled();
});

it('stops at Disconnect without reopening downloads', async () => {
  const { db, raw } = await createTestDb();
  const cache = new FakeCache();
  seedOversizedLegacyCache(cache, raw);
  const currentLease = lease();

  const result = await repairAttachmentCache(db, currentLease, {
    scanForRepair: cache.repairScan(2),
    scan: cache.startupScan,
    coordinator: new AttachmentCacheCoordinator(cache.io, () => NOW),
    now: () => NOW,
    onProgress: () => currentLease.revoke(),
  });

  expect(result).toEqual({ status: 'stale' });
  expect(cache.startupScan).not.toHaveBeenCalled();
  expect(isAttachmentCacheRecoveryReady(currentLease)).toBe(false);
});

it('stops as blocked instead of growing the ledger past what startup can read', async () => {
  const { db, raw } = await createTestDb();
  const cache = new FakeCache();
  seedOversizedLegacyCache(cache, raw);
  const insert = raw.prepare(
    `INSERT INTO attachment_cache_entries (path, bytes, last_used_at, state, attempts, next_retry_at)
     VALUES (?, 1, 1, 'active', 0, 0)`,
  );
  raw.transaction(() => {
    for (let index = 0; index < 8_092; index += 1) insert.run(legacy(`kept-${index}`));
  })();
  // Every file is in use, so cleanup cannot remove anything.
  const idle = { status: 'complete' as const, attempted: 0, confirmed: 0, failed: 0, skipped: 0 };
  const coordinator = new AttachmentCacheCoordinator(cache.io, () => NOW);
  jest.spyOn(coordinator, 'retireInactiveEntries').mockResolvedValue(idle);
  jest.spyOn(coordinator, 'conformCurrentQuota').mockResolvedValue({ ...idle, withinQuota: false });
  const currentLease = lease();

  const result = await repairAttachmentCache(db, currentLease, {
    scanForRepair: cache.repairScan(2),
    scan: cache.startupScan,
    coordinator,
    now: () => NOW,
  });

  expect(result).toEqual({ status: 'blocked', checkedFiles: 2, removedFiles: 0 });
  expect(cache.startupScan).not.toHaveBeenCalled();
  expect(cache.files.size).toBe(5);
  expect(isAttachmentCacheRecoveryReady(currentLease)).toBe(false);
});

it('reports a failed repair and still lets the next recovery run', async () => {
  const { db } = await createTestDb();
  const cache = new FakeCache();
  const currentLease = lease();
  const coordinator = new AttachmentCacheCoordinator(cache.io, () => NOW);

  await expect(
    repairAttachmentCache(db, currentLease, {
      scanForRepair: async () => {
        throw new Error('Attachment cache scan corrupt');
      },
      coordinator,
      now: () => NOW,
    }),
  ).rejects.toThrow('Attachment cache scan corrupt');
  expect(isAttachmentCacheRecoveryReady(currentLease)).toBe(false);

  await expect(
    recoverAttachmentCache(db, currentLease, {
      scan: cache.startupScan,
      coordinator,
      now: () => NOW,
    }),
  ).resolves.toMatchObject({ status: 'ready' });
});
