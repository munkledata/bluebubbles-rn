import {
  createAttachmentCacheReservation,
  getAttachmentCacheEntry,
  listAttachmentCacheEntriesForRecovery,
  recordAttachmentCacheEntry,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import type { AttachmentCacheScanFile } from '@native/boundedDownload';
import { sql } from 'drizzle-orm';
import {
  AttachmentCacheCoordinator,
  type AttachmentCacheNativeBoundary,
} from '@/services/download/attachmentCacheCoordinator';
import {
  invalidateAttachmentCacheRecoveryReadiness,
  isAttachmentCacheRecoveryReady,
  recoverAttachmentCache,
} from '@/services/download/attachmentCacheRecovery';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import {
  holdRollingBackDbNeighbour,
  observePromise,
  type RollingBackDbNeighbour,
} from '../support/dbOwnershipProof';
import { createTestDb } from '../support/testDb';

const NOW = 10_000;
const OVER_LIMIT_REFERENCES = 1001;
const scoped = (name: string): string =>
  `file:///data/app/files/attachments/media-${name}/generation-1/media-${name}.jpg`;
const legacy = (name: string): string => `file:///data/app/files/attachments/${name}/${name}.jpg`;
type TestDatabase = Awaited<ReturnType<typeof createTestDb>>['raw'];

function seedAttachmentReferences(
  raw: TestDatabase,
  path: string,
  count: number,
  prefix: string,
): void {
  const insert = raw.prepare(`INSERT INTO attachments (guid, local_path) VALUES (?, ?)`);
  raw.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      insert.run(`${prefix}-${index}`, path);
    }
  })();
}

function countAttachmentReferences(raw: TestDatabase, path: string): number {
  return (
    raw.prepare(`SELECT COUNT(*) AS count FROM attachments WHERE local_path = ?`).get(path) as {
      count: number;
    }
  ).count;
}

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

function nativeBoundary(
  existing: Map<string, number>,
  overrides: Partial<AttachmentCacheNativeBoundary> = {},
): AttachmentCacheNativeBoundary {
  return {
    getAvailableBytes: jest.fn(async () => 4 * 1024 * 1024 * 1024),
    statFile: jest.fn(async (path) => ({
      exists: existing.has(path),
      bytes: existing.get(path) ?? 0,
    })),
    deleteFile: jest.fn(async (path) => {
      const bytes = existing.get(path) ?? 0;
      const found = existing.delete(path);
      return { status: found ? ('deleted' as const) : ('missing' as const), bytes };
    }),
    ...overrides,
  };
}

async function seedLiveReference(db: AppDatabase, guid: string, path: string): Promise<void> {
  // Recovery only needs an exact attachment reference; a missing message owner follows the same
  // conservative live-reference rule as outgoing/local rows.
  await db.run(sql`INSERT INTO attachments (guid, local_path) VALUES (${guid}, ${path})`);
}

beforeEach(() => {
  invalidateAttachmentCacheRecoveryReadiness();
  resumeRealtimeDeliveries();
});

afterEach(async () => {
  await pauseRealtimeDeliveries();
  resumeRealtimeDeliveries();
});

it('adopts exact legacy/scoped references, retires orphans, and repairs missing active files', async () => {
  const { db } = await createTestDb();
  const currentLease = lease();
  const liveLegacy = legacy('legacy-live');
  const liveScoped = scoped('scoped-live');
  const orphan = scoped('orphan');
  const missing = scoped('missing-ledger');
  await seedLiveReference(db, 'legacy-live', liveLegacy);
  await seedLiveReference(db, 'scoped-live', liveScoped);
  await seedLiveReference(db, 'missing-ref', missing);
  await withDbTransaction(db, (context) =>
    recordAttachmentCacheEntry(context, { path: missing, bytes: 99, lastUsedAt: 1 }),
  );
  const physical = new Map([
    [liveLegacy, 11],
    [liveScoped, 22],
    [orphan, 33],
  ]);
  const io = nativeBoundary(physical);
  const coordinator = new AttachmentCacheCoordinator(io, () => NOW);

  await expect(
    recoverAttachmentCache(db, currentLease, {
      coordinator,
      now: () => NOW,
      scan: async () => [
        { uri: liveLegacy, bytes: 11, mtimeMs: NOW - 20 },
        { uri: liveScoped, bytes: 22, mtimeMs: NOW - 10 },
        { uri: orphan, bytes: 33, mtimeMs: NOW + 50_000 },
      ],
    }),
  ).resolves.toEqual({
    status: 'ready',
    scannedFiles: 3,
    adoptedFiles: 3,
    deferredFiles: 0,
    repairedMissingFiles: 1,
    retiredFiles: 1,
    withinQuota: true,
  });

  expect(isAttachmentCacheRecoveryReady(currentLease)).toBe(true);
  expect(await getAttachmentCacheEntry(db, liveLegacy)).toMatchObject({
    state: 'active',
    bytes: 11,
  });
  expect(await getAttachmentCacheEntry(db, liveScoped)).toMatchObject({
    state: 'active',
    bytes: 22,
  });
  expect(await getAttachmentCacheEntry(db, orphan)).toBeNull();
  expect(physical.has(orphan)).toBe(false);
  expect(await getAttachmentCacheEntry(db, missing)).toBeNull();
});

it('collects the whole scan before its first DB or native-delete mutation', async () => {
  const { db } = await createTestDb();
  const currentLease = lease();
  const coordinator = new AttachmentCacheCoordinator(nativeBoundary(new Map()), () => NOW);
  const before = await listAttachmentCacheEntriesForRecovery(db);
  expect(before).toEqual([]);

  await expect(
    recoverAttachmentCache(db, currentLease, {
      coordinator,
      now: () => NOW,
      scan: async () => {
        expect(await listAttachmentCacheEntriesForRecovery(db)).toEqual([]);
        throw new Error('late scan corruption');
      },
    }),
  ).rejects.toThrow('late scan corruption');

  expect(await listAttachmentCacheEntriesForRecovery(db)).toEqual([]);
  expect(isAttachmentCacheRecoveryReady(currentLease)).toBe(false);
});

it('rejects a duplicate after the first batch before making any recovery mutation', async () => {
  const { db } = await createTestDb();
  const currentLease = lease();
  const io = nativeBoundary(new Map());
  const coordinator = new AttachmentCacheCoordinator(io, () => NOW);
  const firstHundred = Array.from({ length: 100 }, (_, index) => ({
    uri: scoped(`duplicate-check-${index}`),
    bytes: 1,
    mtimeMs: 1,
  }));

  await expect(
    recoverAttachmentCache(db, currentLease, {
      coordinator,
      now: () => NOW,
      scan: async () => [...firstHundred, firstHundred[0]!],
    }),
  ).rejects.toThrow('malformed or contains duplicates');
  expect(await listAttachmentCacheEntriesForRecovery(db)).toEqual([]);
  expect(io.deleteFile).not.toHaveBeenCalled();
});

it('queues each adoption owner behind a rolling-back neighbour and commits independently', async () => {
  const { db, raw } = await createTestDb();
  const currentLease = lease();
  const file = scoped('adoption-neighbour');
  const physical = new Map([[file, 17]]);
  const io = nativeBoundary(physical);
  const coordinator = new AttachmentCacheCoordinator(io, () => NOW);
  let neighbour: RollingBackDbNeighbour | undefined;
  let recovery: Promise<unknown> | undefined;
  let resolveScan!: (files: AttachmentCacheScanFile[]) => void;
  let announceScan!: () => void;
  const scanStarted = new Promise<void>((resolve) => {
    announceScan = resolve;
  });
  const scanResult = new Promise<AttachmentCacheScanFile[]>((resolve) => {
    resolveScan = resolve;
  });
  try {
    await seedLiveReference(db, 'adoption-neighbour-live', file);
    neighbour = holdRollingBackDbNeighbour(db, () => {
      raw.prepare("INSERT INTO kv (key, value) VALUES ('recovery-neighbour', 'dirty')").run();
    });
    await neighbour.entered;

    const observed = observePromise(
      (recovery = recoverAttachmentCache(db, currentLease, {
        coordinator,
        now: () => NOW,
        scan: () => {
          announceScan();
          return scanResult;
        },
      })),
    );
    await scanStarted;
    const afterScan = scanResult.then(() => undefined);
    resolveScan([{ uri: file, bytes: 17, mtimeMs: 2 }]);
    await afterScan;
    await Promise.resolve();
    expect(observed.settled()).toBe(false);
    expect(
      raw.prepare('SELECT state FROM attachment_cache_entries WHERE path = ?').get(file),
    ).toBeUndefined();

    neighbour.release();
    await expect(neighbour.outcome).resolves.toMatchObject({ status: 'rolled-back' });
    await expect(observed.promise).resolves.toMatchObject({
      status: 'ready',
      adoptedFiles: 1,
    });
    expect(
      raw.prepare("SELECT value FROM kv WHERE key = 'recovery-neighbour'").get(),
    ).toBeUndefined();
    expect(await getAttachmentCacheEntry(db, file)).toMatchObject({
      state: 'active',
      bytes: 17,
    });
    expect(io.deleteFile).not.toHaveBeenCalled();
  } finally {
    resolveScan?.([]);
    await neighbour?.cleanup();
    if (recovery) await Promise.allSettled([recovery]);
    raw.close();
  }
});

it('drains a queued revoked adoption and lets the fresh generation recover it', async () => {
  const { db, raw } = await createTestDb();
  const staleLease = captureRealtimeDeliveryLease();
  const file = scoped('adoption-revoked');
  const physical = new Map([[file, 19]]);
  const io = nativeBoundary(physical);
  const coordinator = new AttachmentCacheCoordinator(io, () => NOW);
  let neighbour: RollingBackDbNeighbour | undefined;
  let recovery: Promise<unknown> | undefined;
  let pause: Promise<void> | undefined;
  let resolveScan!: (files: AttachmentCacheScanFile[]) => void;
  let announceScan!: () => void;
  const scanStarted = new Promise<void>((resolve) => {
    announceScan = resolve;
  });
  const scanResult = new Promise<AttachmentCacheScanFile[]>((resolve) => {
    resolveScan = resolve;
  });
  try {
    await seedLiveReference(db, 'adoption-revoked-live', file);
    neighbour = holdRollingBackDbNeighbour(db, () => {
      raw
        .prepare("INSERT INTO kv (key, value) VALUES ('recovery-revoked-neighbour', 'dirty')")
        .run();
    });
    await neighbour.entered;

    recovery = recoverAttachmentCache(db, staleLease, {
      coordinator,
      now: () => NOW,
      scan: () => {
        announceScan();
        return scanResult;
      },
    });
    const observedRecovery = observePromise(recovery);
    await scanStarted;
    const afterScan = scanResult.then(() => undefined);
    resolveScan([{ uri: file, bytes: 19, mtimeMs: 3 }]);
    await afterScan;
    await Promise.resolve();

    const observedPause = observePromise((pause = pauseRealtimeDeliveries()));
    await Promise.resolve();
    expect(observedPause.settled()).toBe(false);
    expect(observedRecovery.settled()).toBe(false);

    neighbour.release();
    await expect(neighbour.outcome).resolves.toMatchObject({ status: 'rolled-back' });
    await expect(observedRecovery.promise).resolves.toMatchObject({ status: 'stale' });
    await expect(observedPause.promise).resolves.toBeUndefined();
    expect(await getAttachmentCacheEntry(db, file)).toBeNull();
    expect(
      raw
        .prepare('SELECT local_path AS localPath FROM attachments WHERE guid = ?')
        .get('adoption-revoked-live'),
    ).toEqual({ localPath: file });
    expect(io.deleteFile).not.toHaveBeenCalled();
    expect(isAttachmentCacheRecoveryReady(staleLease)).toBe(false);

    resumeRealtimeDeliveries();
    const freshLease = captureRealtimeDeliveryLease();
    await expect(
      recoverAttachmentCache(db, freshLease, {
        coordinator,
        now: () => NOW,
        scan: async () => [{ uri: file, bytes: 19, mtimeMs: 3 }],
      }),
    ).resolves.toMatchObject({ status: 'ready', adoptedFiles: 1 });
    expect(await getAttachmentCacheEntry(db, file)).toMatchObject({
      state: 'active',
      bytes: 19,
    });
    expect(isAttachmentCacheRecoveryReady(freshLease)).toBe(true);
  } finally {
    resolveScan?.([]);
    neighbour?.release();
    await neighbour?.cleanup();
    if (recovery) await Promise.allSettled([recovery]);
    if (pause) await Promise.allSettled([pause]);
    resumeRealtimeDeliveries();
    raw.close();
  }
});

it('drains a queued revoked ledger read and lets the fresh generation finish empty recovery', async () => {
  const { db, raw } = await createTestDb();
  const staleLease = captureRealtimeDeliveryLease();
  const coordinator = new AttachmentCacheCoordinator(nativeBoundary(new Map()), () => NOW);
  let neighbour: RollingBackDbNeighbour | undefined;
  let recovery: Promise<unknown> | undefined;
  let pause: Promise<void> | undefined;
  try {
    neighbour = holdRollingBackDbNeighbour(db, () => {
      raw
        .prepare("INSERT INTO kv (key, value) VALUES ('recovery-ledger-neighbour', 'dirty')")
        .run();
    });
    await neighbour.entered;

    const observedRecovery = observePromise(
      (recovery = recoverAttachmentCache(db, staleLease, {
        coordinator,
        now: () => NOW,
        scan: async () => [],
      })),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(observedRecovery.settled()).toBe(false);

    const observedPause = observePromise((pause = pauseRealtimeDeliveries()));
    await Promise.resolve();
    expect(observedPause.settled()).toBe(false);

    neighbour.release();
    await expect(neighbour.outcome).resolves.toMatchObject({ status: 'rolled-back' });
    await expect(observedRecovery.promise).resolves.toMatchObject({ status: 'stale' });
    await expect(observedPause.promise).resolves.toBeUndefined();
    expect(isAttachmentCacheRecoveryReady(staleLease)).toBe(false);
    expect(
      raw.prepare("SELECT value FROM kv WHERE key = 'recovery-ledger-neighbour'").get(),
    ).toBeUndefined();

    resumeRealtimeDeliveries();
    const freshLease = captureRealtimeDeliveryLease();
    await expect(
      recoverAttachmentCache(db, freshLease, {
        coordinator,
        now: () => NOW,
        scan: async () => [],
      }),
    ).resolves.toMatchObject({ status: 'ready', scannedFiles: 0 });
    expect(isAttachmentCacheRecoveryReady(freshLease)).toBe(true);
  } finally {
    neighbour?.release();
    await neighbour?.cleanup();
    if (recovery) await Promise.allSettled([recovery]);
    if (pause) await Promise.allSettled([pause]);
    resumeRealtimeDeliveries();
    raw.close();
  }
});

it('adopts a 101-file manifest through bounded 100-plus-1 transactions', async () => {
  const { db, raw } = await createTestDb();
  const currentLease = lease();
  const manifest = Array.from({ length: 101 }, (_, index) => ({
    uri: scoped(`adoption-page-${index}`),
    bytes: index + 1,
    mtimeMs: index + 1,
  }));
  const physical = new Map(manifest.map((file) => [file.uri, file.bytes]));
  const io = nativeBoundary(physical);
  const coordinator = new AttachmentCacheCoordinator(io, () => NOW);
  try {
    const insert = raw.prepare('INSERT INTO attachments (guid, local_path) VALUES (?, ?)');
    raw.transaction(() => {
      manifest.forEach((file, index) => insert.run(`adoption-page-live-${index}`, file.uri));
    })();

    await expect(
      recoverAttachmentCache(db, currentLease, {
        coordinator,
        now: () => NOW,
        scan: async () => manifest,
      }),
    ).resolves.toMatchObject({
      status: 'ready',
      scannedFiles: 101,
      adoptedFiles: 101,
      retiredFiles: 0,
    });
    const entries = await listAttachmentCacheEntriesForRecovery(db);
    expect(entries).toHaveLength(101);
    expect(entries.every((entry) => entry.state === 'active')).toBe(true);
    expect(io.deleteFile).not.toHaveBeenCalled();
  } finally {
    raw.close();
  }
});

it('shares one recovery barrier for concurrent callers in the same account generation', async () => {
  const { db } = await createTestDb();
  const currentLease = lease();
  const coordinator = new AttachmentCacheCoordinator(nativeBoundary(new Map()), () => NOW);
  let releaseScan!: () => void;
  const scan = jest.fn(
    () =>
      new Promise<[]>((resolve) => {
        releaseScan = () => resolve([]);
      }),
  );

  const first = recoverAttachmentCache(db, currentLease, { coordinator, now: () => NOW, scan });
  const second = recoverAttachmentCache(db, currentLease, { coordinator, now: () => NOW, scan });

  expect(first).toBe(second);
  await Promise.resolve();
  expect(scan).toHaveBeenCalledTimes(1);
  releaseScan();
  await expect(Promise.all([first, second])).resolves.toEqual([
    expect.objectContaining({ status: 'ready' }),
    expect.objectContaining({ status: 'ready' }),
  ]);
});

it('serializes a replacement-account scan behind the stale native scan owner', async () => {
  const { db } = await createTestDb();
  const oldLease = lease(7);
  const newLease = lease(8);
  const coordinator = new AttachmentCacheCoordinator(nativeBoundary(new Map()), () => NOW);
  let releaseOldScan!: () => void;
  const oldScan = jest.fn(
    () =>
      new Promise<[]>((resolve) => {
        releaseOldScan = () => resolve([]);
      }),
  );
  const newScan = jest.fn(async () => []);

  const oldRecovery = recoverAttachmentCache(db, oldLease, {
    coordinator,
    now: () => NOW,
    scan: oldScan,
  });
  await Promise.resolve();
  expect(oldScan).toHaveBeenCalledTimes(1);

  oldLease.revoke();
  const newRecovery = recoverAttachmentCache(db, newLease, {
    coordinator,
    now: () => NOW,
    scan: newScan,
  });
  await Promise.resolve();
  expect(newScan).not.toHaveBeenCalled();

  releaseOldScan();
  await expect(oldRecovery).resolves.toMatchObject({ status: 'stale' });
  await expect(newRecovery).resolves.toMatchObject({ status: 'ready' });
  expect(newScan).toHaveBeenCalledTimes(1);
  expect(isAttachmentCacheRecoveryReady(newLease)).toBe(true);
});

it('does not let a failed scan poison the next account recovery', async () => {
  const { db } = await createTestDb();
  const failedLease = lease(9);
  const nextLease = lease(10);
  const coordinator = new AttachmentCacheCoordinator(nativeBoundary(new Map()), () => NOW);

  await expect(
    recoverAttachmentCache(db, failedLease, {
      coordinator,
      now: () => NOW,
      scan: async () => {
        throw new Error('native inventory failed');
      },
    }),
  ).rejects.toThrow('native inventory failed');
  failedLease.revoke();

  await expect(
    recoverAttachmentCache(db, nextLease, {
      coordinator,
      now: () => NOW,
      scan: async () => [],
    }),
  ).resolves.toMatchObject({ status: 'ready' });
  expect(isAttachmentCacheRecoveryReady(nextLease)).toBe(true);
});

it('drains a crash-surviving reserved file instead of reviving it', async () => {
  const { db } = await createTestDb();
  const currentLease = lease();
  const reserved = scoped('reserved');
  await withDbTransaction(db, (context) =>
    createAttachmentCacheReservation(context, { path: reserved, maxBytes: 100, createdAt: 1 }),
  );
  const physical = new Map([[reserved, 40]]);
  const coordinator = new AttachmentCacheCoordinator(nativeBoundary(physical), () => NOW);

  await expect(
    recoverAttachmentCache(db, currentLease, {
      coordinator,
      now: () => NOW,
      scan: async () => [{ uri: reserved, bytes: 40, mtimeMs: 2 }],
    }),
  ).resolves.toMatchObject({ status: 'ready', adoptedFiles: 0, deferredFiles: 1 });
  expect(await getAttachmentCacheEntry(db, reserved)).toBeNull();
  expect(physical.has(reserved)).toBe(false);
});

it('retires a zero-byte completed file instead of publishing an unusable cache hit', async () => {
  const { db, raw } = await createTestDb();
  const currentLease = lease();
  const zero = scoped('zero');
  await seedLiveReference(db, 'zero-live', zero);
  const physical = new Map([[zero, 0]]);
  const coordinator = new AttachmentCacheCoordinator(nativeBoundary(physical), () => NOW);

  await expect(
    recoverAttachmentCache(db, currentLease, {
      coordinator,
      now: () => NOW,
      scan: async () => [{ uri: zero, bytes: 0, mtimeMs: 2 }],
    }),
  ).resolves.toMatchObject({
    status: 'ready',
    adoptedFiles: 0,
    deferredFiles: 1,
    retiredFiles: 1,
  });
  expect(await getAttachmentCacheEntry(db, zero)).toBeNull();
  expect(physical.has(zero)).toBe(false);
  expect(
    raw.prepare(`SELECT local_path AS localPath FROM attachments WHERE guid = 'zero-live'`).get(),
  ).toEqual({ localPath: null });
});

it('keeps recovery closed and untouched when zero-byte adoption exceeds the reference cap', async () => {
  const { db, raw } = await createTestDb();
  const currentLease = lease();
  const zero = scoped('zero-reference-overflow');
  seedAttachmentReferences(raw, zero, OVER_LIMIT_REFERENCES, 'zero-overflow-reference');
  const physical = new Map([[zero, 0]]);
  const io = nativeBoundary(physical);
  const coordinator = new AttachmentCacheCoordinator(io, () => NOW);

  await expect(
    recoverAttachmentCache(db, currentLease, {
      coordinator,
      now: () => NOW,
      scan: async () => [{ uri: zero, bytes: 0, mtimeMs: 2 }],
    }),
  ).rejects.toThrow('must not exceed 1000 rows per transaction');

  expect(isAttachmentCacheRecoveryReady(currentLease)).toBe(false);
  expect(io.deleteFile).not.toHaveBeenCalled();
  expect(physical.get(zero)).toBe(0);
  expect(await getAttachmentCacheEntry(db, zero)).toBeNull();
  expect(countAttachmentReferences(raw, zero)).toBe(OVER_LIMIT_REFERENCES);
});

it('keeps recovery closed and untouched when missing-file repair exceeds the reference cap', async () => {
  const { db, raw } = await createTestDb();
  const currentLease = lease();
  const missing = scoped('missing-reference-overflow');
  await withDbTransaction(db, (context) =>
    recordAttachmentCacheEntry(context, { path: missing, bytes: 99, lastUsedAt: 1 }),
  );
  seedAttachmentReferences(raw, missing, OVER_LIMIT_REFERENCES, 'missing-overflow-reference');
  const io = nativeBoundary(new Map());
  const coordinator = new AttachmentCacheCoordinator(io, () => NOW);

  await expect(
    recoverAttachmentCache(db, currentLease, {
      coordinator,
      now: () => NOW,
      scan: async () => [],
    }),
  ).rejects.toThrow('must not exceed 1000 rows per transaction');

  expect(isAttachmentCacheRecoveryReady(currentLease)).toBe(false);
  expect(io.deleteFile).not.toHaveBeenCalled();
  expect(await getAttachmentCacheEntry(db, missing)).toEqual({
    path: missing,
    bytes: 99,
    lastUsedAt: 1,
    state: 'active',
    attempts: 0,
    nextRetryAt: 0,
  });
  expect(countAttachmentReferences(raw, missing)).toBe(OVER_LIMIT_REFERENCES);
});

it('never publishes readiness when the account lease is revoked after scanning', async () => {
  const { db } = await createTestDb();
  const currentLease = lease();
  const file = scoped('stale');

  await expect(
    recoverAttachmentCache(db, currentLease, {
      coordinator: new AttachmentCacheCoordinator(nativeBoundary(new Map()), () => NOW),
      now: () => NOW,
      scan: async () => {
        currentLease.revoke();
        return [{ uri: file, bytes: 1, mtimeMs: 1 }];
      },
    }),
  ).resolves.toMatchObject({ status: 'stale', scannedFiles: 1 });
  expect(await getAttachmentCacheEntry(db, file)).toBeNull();
  expect(isAttachmentCacheRecoveryReady(currentLease)).toBe(false);
});

it('rolls back a batch whose generation guard is revoked before commit', async () => {
  const { db, raw } = await createTestDb();
  const currentLease = lease();
  const file = scoped('guarded');
  raw.function('test_revoke_recovery', () => currentLease.revoke());
  raw.exec(`
    CREATE TRIGGER revoke_recovery_generation
    AFTER INSERT ON attachment_cache_entries
    BEGIN
      SELECT test_revoke_recovery();
    END;
  `);

  await expect(
    recoverAttachmentCache(db, currentLease, {
      coordinator: new AttachmentCacheCoordinator(nativeBoundary(new Map([[file, 1]])), () => NOW),
      now: () => NOW,
      scan: async () => [{ uri: file, bytes: 1, mtimeMs: 1 }],
    }),
  ).resolves.toMatchObject({ status: 'stale' });
  expect(await getAttachmentCacheEntry(db, file)).toBeNull();
});

it('publishes readiness but reports when protected rows prevent quota conformance', async () => {
  const { db } = await createTestDb();
  const currentLease = lease();
  const coordinator = new AttachmentCacheCoordinator(nativeBoundary(new Map()), () => NOW);
  jest.spyOn(coordinator, 'conformCurrentQuota').mockResolvedValue({
    status: 'complete',
    withinQuota: false,
    attempted: 0,
    confirmed: 0,
    failed: 0,
    skipped: 1,
  });

  await expect(
    recoverAttachmentCache(db, currentLease, {
      coordinator,
      now: () => NOW,
      scan: async () => [],
    }),
  ).resolves.toMatchObject({ status: 'ready', withinQuota: false });
  expect(isAttachmentCacheRecoveryReady(currentLease)).toBe(true);
});

it('does not publish readiness when quota conformance becomes stale', async () => {
  const { db } = await createTestDb();
  const currentLease = lease();
  const coordinator = new AttachmentCacheCoordinator(nativeBoundary(new Map()), () => NOW);
  jest.spyOn(coordinator, 'conformCurrentQuota').mockResolvedValue({
    status: 'stale',
    withinQuota: false,
    attempted: 0,
    confirmed: 0,
    failed: 0,
    skipped: 0,
  });

  await expect(
    recoverAttachmentCache(db, currentLease, {
      coordinator,
      now: () => NOW,
      scan: async () => [],
    }),
  ).resolves.toMatchObject({ status: 'stale', withinQuota: false });
  expect(isAttachmentCacheRecoveryReady(currentLease)).toBe(false);
});
