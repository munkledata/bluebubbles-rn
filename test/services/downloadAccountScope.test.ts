/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
let activeDb: unknown;

jest.mock('@db/database', () => ({ getDatabase: () => activeDb }));
jest.mock('@/services/clients', () => ({ http: {} }));
jest.mock('@/services/download/expoFetcher', () => ({
  expoFetcher: () => ({ exists: () => false, download: jest.fn() }),
}));

import { Attachment, Chat, Message } from '@core/models';
import {
  createAttachmentCacheReservation,
  getAttachmentByGuid,
  getAttachmentCacheEntry,
  recordAttachmentCacheEntry,
  updateAttachmentLocalPath,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import {
  deleteNativeAttachmentCacheFile,
  getNativeAttachmentCacheAvailableBytes,
  statNativeAttachmentCacheFile,
} from '@native/boundedDownload';
import { download, setAttachmentFetcher } from '@/services/download';
import { createAttachmentCacheAccountScope } from '@/services/download/attachmentCacheAccountScope';
import { AttachmentCacheCoordinator } from '@/services/download/attachmentCacheCoordinator';
import { recoverAttachmentCache } from '@/services/download/attachmentCacheRecovery';
import { ATTACHMENT_CACHE_MAX_BYTES } from '@/services/download/attachmentCacheQuotaPolicy';
import { AttachmentFetchError } from '@/services/download/downloadService';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { withDbTransaction } from '@db/transaction';
import {
  holdRollingBackDbNeighbour,
  type RollingBackDbNeighbour,
} from '../support/dbOwnershipProof';
import { createTestDb } from '../support/testDb';

type Outcome<T> = { kind: 'fulfilled'; value: T } | { kind: 'rejected'; error: unknown };

function observe<T>(promise: Promise<T>): { outcome: Promise<Outcome<T>>; settled(): boolean } {
  let didSettle = false;
  const outcome = promise.then<Outcome<T>, Outcome<T>>(
    (value) => ({ kind: 'fulfilled', value }),
    (error: unknown) => ({ kind: 'rejected', error }),
  );
  void outcome.then(() => {
    didSettle = true;
  });
  return { outcome, settled: () => didSettle };
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function seedRcsAttachment(db: AppDatabase) {
  const handles = await upsertHandles(db, [{ address: 'rcs@x.com' }]);
  const chats = await upsertChats(
    db,
    [Chat.parse({ guid: 'RCS;-;scope-chat', participants: [{ address: 'rcs@x.com' }] })],
    handles,
  );
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: 'scope-message',
        dateCreated: 1,
        hasAttachments: true,
        attachments: [
          Attachment.parse({
            guid: 'scope-attachment',
            mimeType: 'image/jpeg',
            transferName: 'photo.jpg',
            totalBytes: 1_000,
          }),
        ],
      }),
    ],
    () => chats.get('RCS;-;scope-chat')!,
    handles,
  );
  return (await getAttachmentByGuid(db, 'scope-attachment'))!;
}

afterEach(async () => {
  jest.clearAllTimers();
  jest.useRealTimers();
  await pauseRealtimeDeliveries();
  resumeRealtimeDeliveries();
});

describe('account-scoped attachment retries', () => {
  it('commits the cache reservation after a rolling neighbour and before native download starts', async () => {
    const { db, raw } = await createTestDb();
    activeDb = db;
    await recoverAttachmentCache(db, captureRealtimeDeliveryLease());
    const attachment = await seedRcsAttachment(db);
    jest
      .mocked(getNativeAttachmentCacheAvailableBytes)
      .mockResolvedValueOnce(Number.MAX_SAFE_INTEGER);
    const finalPath =
      'file:///documents/attachments/media-scope-attachment/generation-0/media-owner-proof.jpg';
    let releaseNeighbour!: () => void;
    const neighbourGate = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    let neighbourStarted = false;
    let neighbour: ReturnType<typeof observe<void>> | undefined;
    type All = (...args: Parameters<AppDatabase['all']>) => ReturnType<AppDatabase['all']>;
    const realAll = db.all.bind(db) as All;
    const allSpy = jest.spyOn(db, 'all').mockImplementation(((...args) => {
      const shape = JSON.stringify(args[0]).replace(/\s+/g, ' ').toLowerCase();
      if (!neighbour && shape.includes('candidate_page') && shape.includes('usage_files')) {
        // Claim the next queue slot while the quota snapshot transaction is still open. This
        // positions the rolling neighbour directly between planning and reservation creation.
        neighbour = observe(
          withDbTransaction(db, async (_context) => {
            raw
              .prepare("INSERT INTO kv (key, value) VALUES ('cache-owner-neighbour', 'dirty')")
              .run();
            neighbourStarted = true;
            await neighbourGate;
            throw new Error('cache owner neighbour rollback');
          }),
        );
      }
      return realAll(...args);
    }) as AppDatabase['all']);

    let reservationAtDownload: ReturnType<typeof getAttachmentCacheEntry> | undefined;
    let transactionAtDownload: boolean | undefined;
    const downloadNative = jest.fn(async () => {
      transactionAtDownload = raw.inTransaction;
      reservationAtDownload = getAttachmentCacheEntry(db, finalPath);
      return { localPath: finalPath, bytes: 1_000 };
    });
    setAttachmentFetcher({
      exists: () => false,
      destinationUri: () => finalPath,
      download: downloadNative,
    });
    const ownedDownload = observe(download(attachment, 'manual', captureRealtimeDeliveryLease()));

    try {
      await waitFor(() => neighbourStarted, 'cache reservation neighbour');
      expect(ownedDownload.settled()).toBe(false);
      expect(downloadNative).not.toHaveBeenCalled();
      expect(
        raw.prepare('SELECT 1 FROM attachment_cache_entries WHERE path = ?').get(finalPath),
      ).toBeUndefined();

      releaseNeighbour();
      await expect(neighbour?.outcome).resolves.toMatchObject({ kind: 'rejected' });
      await expect(ownedDownload.outcome).resolves.toEqual({
        kind: 'fulfilled',
        value: finalPath,
      });
      await expect(reservationAtDownload).resolves.toMatchObject({
        path: finalPath,
        state: 'reserved',
      });
      expect(transactionAtDownload).toBe(false);
      expect(await getAttachmentCacheEntry(db, finalPath)).toMatchObject({
        path: finalPath,
        bytes: 1_000,
        state: 'active',
      });
      expect((await getAttachmentByGuid(db, attachment.guid))?.localPath).toBe(finalPath);
      expect(
        raw.prepare("SELECT value FROM kv WHERE key = 'cache-owner-neighbour'").get(),
      ).toBeUndefined();
    } finally {
      releaseNeighbour();
      allSpy.mockRestore();
      await Promise.allSettled([neighbour?.outcome ?? Promise.resolve(), ownedDownload.outcome]);
      raw.close();
    }
  });

  it('rejects a verified download whose final commit waits past account revocation', async () => {
    const { db, raw } = await createTestDb();
    activeDb = db;
    await recoverAttachmentCache(db, captureRealtimeDeliveryLease());
    const attachment = await seedRcsAttachment(db);
    jest.mocked(getNativeAttachmentCacheAvailableBytes).mockResolvedValue(Number.MAX_SAFE_INTEGER);
    const finalPath =
      'file:///documents/attachments/media-scope-attachment/generation-0/media-final-guard.jpg';
    let neighbour: RollingBackDbNeighbour | undefined;
    const discard = jest.fn(async () => undefined);
    const downloadNative = jest.fn(async () => {
      neighbour = holdRollingBackDbNeighbour(
        db,
        () => {
          raw
            .prepare("INSERT INTO kv (key, value) VALUES ('cache-final-neighbour', 'dirty')")
            .run();
        },
        'cache final commit neighbour rollback',
      );
      await neighbour.entered;
      return { localPath: finalPath, bytes: 1_000 };
    });
    setAttachmentFetcher({
      exists: () => false,
      destinationUri: () => finalPath,
      download: downloadNative,
      discard,
    });
    const ownedDownload = observe(download(attachment, 'manual', captureRealtimeDeliveryLease()));
    let pause: ReturnType<typeof observe<void>> | undefined;

    try {
      await waitFor(() => neighbour !== undefined, 'final download commit neighbour');
      await neighbour!.entered;
      // The verified transfer has returned; this turn lets the final guarded owner claim the next
      // writer slot behind the held neighbour before account admission closes.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(downloadNative).toHaveBeenCalledTimes(1);
      expect(ownedDownload.settled()).toBe(false);

      pause = observe(pauseRealtimeDeliveries());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(pause.settled()).toBe(false);
      expect(ownedDownload.settled()).toBe(false);

      neighbour!.release();
      await expect(neighbour!.outcome).resolves.toMatchObject({ status: 'rolled-back' });
      await expect(ownedDownload.outcome).resolves.toEqual({ kind: 'fulfilled', value: null });
      await expect(pause.outcome).resolves.toEqual({ kind: 'fulfilled', value: undefined });
      expect((await getAttachmentByGuid(db, attachment.guid))?.localPath).toBeNull();
      expect((await getAttachmentCacheEntry(db, finalPath))?.state).not.toBe('active');
      expect(discard).toHaveBeenCalledWith(finalPath);
      expect(
        raw.prepare("SELECT value FROM kv WHERE key = 'cache-final-neighbour'").get(),
      ).toBeUndefined();
    } finally {
      neighbour?.release();
      await neighbour?.cleanup();
      await Promise.allSettled([ownedDownload.outcome, pause?.outcome ?? Promise.resolve()]);
      resumeRealtimeDeliveries();
      raw.close();
    }
  });

  it('abandons a queued reservation when its account is revoked and lets a fresh generation retry', async () => {
    const { db, raw } = await createTestDb();
    activeDb = db;
    await recoverAttachmentCache(db, captureRealtimeDeliveryLease());
    const attachment = await seedRcsAttachment(db);
    jest
      .mocked(getNativeAttachmentCacheAvailableBytes)
      .mockResolvedValueOnce(Number.MAX_SAFE_INTEGER)
      .mockResolvedValueOnce(Number.MAX_SAFE_INTEGER)
      .mockResolvedValueOnce(Number.MAX_SAFE_INTEGER);
    const stalePath =
      'file:///documents/attachments/media-scope-attachment/generation-0/media-stale-proof.jpg';
    const freshPath =
      'file:///documents/attachments/media-scope-attachment/generation-1/media-fresh-proof.jpg';
    let releaseNeighbour!: () => void;
    const neighbourGate = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    let neighbourStarted = false;
    let neighbour: ReturnType<typeof observe<void>> | undefined;
    type All = (...args: Parameters<AppDatabase['all']>) => ReturnType<AppDatabase['all']>;
    const realAll = db.all.bind(db) as All;
    const allSpy = jest.spyOn(db, 'all').mockImplementation(((...args) => {
      const shape = JSON.stringify(args[0]).replace(/\s+/g, ' ').toLowerCase();
      if (!neighbour && shape.includes('candidate_page') && shape.includes('usage_files')) {
        neighbour = observe(
          withDbTransaction(db, async (_context) => {
            raw
              .prepare("INSERT INTO kv (key, value) VALUES ('cache-revoke-neighbour', 'dirty')")
              .run();
            neighbourStarted = true;
            await neighbourGate;
            throw new Error('cache revoke neighbour rollback');
          }),
        );
      }
      return realAll(...args);
    }) as AppDatabase['all']);

    const downloadNative = jest.fn(async () => ({ localPath: freshPath, bytes: 1_000 }));
    const destinationUri = jest.fn().mockReturnValueOnce(stalePath).mockReturnValueOnce(freshPath);
    setAttachmentFetcher({
      exists: () => false,
      destinationUri,
      download: downloadNative,
    });
    const staleDownload = observe(download(attachment, 'manual', captureRealtimeDeliveryLease()));
    let pause: ReturnType<typeof observe<void>> | undefined;
    let freshDownload: ReturnType<typeof observe<string | null>> | undefined;

    try {
      await waitFor(() => neighbourStarted, 'cache revocation neighbour');
      expect(staleDownload.settled()).toBe(false);
      expect(downloadNative).not.toHaveBeenCalled();

      pause = observe(pauseRealtimeDeliveries());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(pause.settled()).toBe(false);
      releaseNeighbour();
      await expect(neighbour?.outcome).resolves.toMatchObject({ kind: 'rejected' });
      await expect(staleDownload.outcome).resolves.toEqual({ kind: 'fulfilled', value: null });
      await expect(pause.outcome).resolves.toEqual({ kind: 'fulfilled', value: undefined });
      expect(downloadNative).not.toHaveBeenCalled();
      expect(await getAttachmentCacheEntry(db, stalePath)).toBeNull();
      expect(await getAttachmentCacheEntry(db, freshPath)).toBeNull();
      expect((await getAttachmentByGuid(db, attachment.guid))?.localPath).toBeNull();

      resumeRealtimeDeliveries();
      await recoverAttachmentCache(db, captureRealtimeDeliveryLease());
      freshDownload = observe(download(attachment, 'manual', captureRealtimeDeliveryLease()));
      await expect(freshDownload.outcome).resolves.toEqual({
        kind: 'fulfilled',
        value: freshPath,
      });
      expect(downloadNative).toHaveBeenCalledTimes(1);
      expect(destinationUri).toHaveBeenNthCalledWith(
        1,
        attachment.guid,
        'photo.jpg',
        expect.any(Number),
      );
      expect(destinationUri).toHaveBeenNthCalledWith(
        2,
        attachment.guid,
        'photo.jpg',
        expect.any(Number),
      );
      expect(await getAttachmentCacheEntry(db, freshPath)).toMatchObject({
        path: freshPath,
        bytes: 1_000,
        state: 'active',
      });
    } finally {
      releaseNeighbour();
      allSpy.mockRestore();
      await Promise.allSettled([
        neighbour?.outcome ?? Promise.resolve(),
        staleDownload.outcome,
        pause?.outcome ?? Promise.resolve(),
        freshDownload?.outcome ?? Promise.resolve(),
      ]);
      raw.close();
    }
  });

  it('rolls back a queued production eviction claim before a fresh generation retries', async () => {
    const { db, raw } = await createTestDb();
    activeDb = db;
    await recoverAttachmentCache(db, captureRealtimeDeliveryLease());
    const attachment = await seedRcsAttachment(db);
    const victim =
      'file:///documents/attachments/media-admission-victim/generation-0/media-old.jpg';
    const destination =
      'file:///documents/attachments/media-scope-attachment/generation-1/media-admission-new.jpg';
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, {
        path: victim,
        bytes: ATTACHMENT_CACHE_MAX_BYTES,
        lastUsedAt: 1,
      }),
    );
    raw
      .prepare(`INSERT INTO attachments (guid, local_path) VALUES ('victim-a', ?), ('victim-b', ?)`)
      .run(victim, victim);
    jest.mocked(getNativeAttachmentCacheAvailableBytes).mockResolvedValue(Number.MAX_SAFE_INTEGER);

    let releaseNeighbour!: () => void;
    const neighbourGate = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    let neighbourStarted = false;
    let neighbour: ReturnType<typeof observe<void>> | undefined;
    type All = (...args: Parameters<AppDatabase['all']>) => ReturnType<AppDatabase['all']>;
    const realAll = db.all.bind(db) as All;
    const allSpy = jest.spyOn(db, 'all').mockImplementation(((...args) => {
      const shape = JSON.stringify(args[0]).replace(/\s+/g, ' ').toLowerCase();
      if (!neighbour && shape.includes('candidate_page') && shape.includes('usage_files')) {
        neighbour = observe(
          withDbTransaction(db, async (_context) => {
            raw.prepare("INSERT INTO kv (key, value) VALUES ('cache-claim-revoke', 'dirty')").run();
            neighbourStarted = true;
            await neighbourGate;
            throw new Error('cache claim revocation neighbour rollback');
          }),
        );
      }
      return realAll(...args);
    }) as AppDatabase['all']);

    let transactionAtDelete: boolean | undefined;
    let stateAtDelete: string | undefined;
    let referencesAtDelete: number | undefined;
    jest.mocked(deleteNativeAttachmentCacheFile).mockImplementationOnce(async () => {
      transactionAtDelete = raw.inTransaction;
      stateAtDelete = (await getAttachmentCacheEntry(db, victim))?.state;
      referencesAtDelete = (
        raw
          .prepare(`SELECT COUNT(*) AS count FROM attachments WHERE local_path = ?`)
          .get(victim) as {
          count: number;
        }
      ).count;
      return { status: 'deleted', bytes: ATTACHMENT_CACHE_MAX_BYTES };
    });
    let reservationAtDownload: ReturnType<typeof getAttachmentCacheEntry> | undefined;
    let transactionAtDownload: boolean | undefined;
    const fetch = jest.fn(async () => {
      transactionAtDownload = raw.inTransaction;
      reservationAtDownload = getAttachmentCacheEntry(db, destination);
      return { localPath: destination, bytes: 1_000 };
    });
    setAttachmentFetcher({
      exists: () => false,
      destinationUri: () => destination,
      download: fetch,
    });
    const staleDownload = observe(download(attachment, 'manual', captureRealtimeDeliveryLease()));
    let pause: ReturnType<typeof observe<void>> | undefined;
    let freshDownload: ReturnType<typeof observe<string | null>> | undefined;

    try {
      await waitFor(() => neighbourStarted, 'production admission claim neighbour');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(staleDownload.settled()).toBe(false);
      expect(deleteNativeAttachmentCacheFile).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(await getAttachmentCacheEntry(db, victim)).toMatchObject({ state: 'active' });
      expect(
        raw.prepare(`SELECT COUNT(*) AS count FROM attachments WHERE local_path = ?`).get(victim),
      ).toEqual({ count: 2 });
      expect(await getAttachmentCacheEntry(db, destination)).toBeNull();

      pause = observe(pauseRealtimeDeliveries());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(pause.settled()).toBe(false);

      releaseNeighbour();
      await expect(neighbour?.outcome).resolves.toMatchObject({ kind: 'rejected' });
      await expect(staleDownload.outcome).resolves.toEqual({ kind: 'fulfilled', value: null });
      await expect(pause.outcome).resolves.toEqual({ kind: 'fulfilled', value: undefined });
      expect(deleteNativeAttachmentCacheFile).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(await getAttachmentCacheEntry(db, victim)).toMatchObject({
        state: 'active',
        bytes: ATTACHMENT_CACHE_MAX_BYTES,
      });
      expect(
        raw.prepare(`SELECT COUNT(*) AS count FROM attachments WHERE local_path = ?`).get(victim),
      ).toEqual({ count: 2 });
      expect(await getAttachmentCacheEntry(db, destination)).toBeNull();
      expect(
        raw.prepare("SELECT value FROM kv WHERE key = 'cache-claim-revoke'").get(),
      ).toBeUndefined();

      resumeRealtimeDeliveries();
      await expect(
        recoverAttachmentCache(db, captureRealtimeDeliveryLease(), {
          scan: async () => [{ uri: victim, bytes: ATTACHMENT_CACHE_MAX_BYTES, mtimeMs: 1 }],
        }),
      ).resolves.toMatchObject({ status: 'ready', retiredFiles: 0, withinQuota: true });
      freshDownload = observe(download(attachment, 'manual', captureRealtimeDeliveryLease()));
      await expect(freshDownload.outcome).resolves.toEqual({
        kind: 'fulfilled',
        value: destination,
      });
      expect(deleteNativeAttachmentCacheFile).toHaveBeenCalledTimes(1);
      expect(deleteNativeAttachmentCacheFile).toHaveBeenCalledWith(victim);
      expect(transactionAtDelete).toBe(false);
      expect(stateAtDelete).toBe('retiring');
      expect(referencesAtDelete).toBe(0);
      expect(transactionAtDownload).toBe(false);
      await expect(reservationAtDownload).resolves.toMatchObject({ state: 'reserved' });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await getAttachmentCacheEntry(db, victim)).toBeNull();
      expect(
        raw.prepare(`SELECT COUNT(*) AS count FROM attachments WHERE local_path = ?`).get(victim),
      ).toEqual({ count: 0 });
      expect(await getAttachmentCacheEntry(db, destination)).toMatchObject({
        state: 'active',
        bytes: 1_000,
      });
    } finally {
      releaseNeighbour();
      allSpy.mockRestore();
      await Promise.allSettled([
        neighbour?.outcome ?? Promise.resolve(),
        staleDownload.outcome,
        pause?.outcome ?? Promise.resolve(),
        freshDownload?.outcome ?? Promise.resolve(),
      ]);
      raw.close();
    }
  });

  it('composes production-style existing-path reuse through native stat and the cache ledger', async () => {
    const { db, raw } = await createTestDb();
    activeDb = db;
    await recoverAttachmentCache(db, captureRealtimeDeliveryLease());
    const attachment = await seedRcsAttachment(db);
    const existingPath =
      'file:///documents/attachments/media-scope-attachment/generation-1/media-photo.jpg';
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: existingPath, bytes: 999, lastUsedAt: 1 }),
    );
    await updateAttachmentLocalPath(db, attachment.guid, existingPath);
    const exists = jest.fn(() => {
      throw new Error('production path must not use Expo File.exists');
    });
    const fetch = jest.fn(async () => ({ localPath: existingPath, bytes: 1_000 }));
    setAttachmentFetcher({
      exists,
      destinationUri: () => existingPath,
      download: fetch,
    });
    let releaseNeighbour!: () => void;
    const neighbourGate = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    let neighbourStarted = false;
    let neighbour: ReturnType<typeof observe<void>> | undefined;
    let transactionAtStat: boolean | undefined;
    jest.mocked(statNativeAttachmentCacheFile).mockImplementationOnce(async () => {
      transactionAtStat = raw.inTransaction;
      neighbour = observe(
        withDbTransaction(db, async (_context) => {
          raw
            .prepare("INSERT INTO kv (key, value) VALUES ('cache-reuse-neighbour', 'dirty')")
            .run();
          neighbourStarted = true;
          await neighbourGate;
          throw new Error('cache reuse neighbour rollback');
        }),
      );
      return { exists: true, bytes: 1_000 };
    });
    const reused = observe(
      download(
        { ...attachment, localPath: existingPath },
        'manual',
        captureRealtimeDeliveryLease(),
      ),
    );

    try {
      await waitFor(() => neighbourStarted, 'cache reuse neighbour');
      expect(transactionAtStat).toBe(false);
      expect(reused.settled()).toBe(false);
      expect(fetch).not.toHaveBeenCalled();

      releaseNeighbour();
      await expect(neighbour?.outcome).resolves.toMatchObject({ kind: 'rejected' });
      await expect(reused.outcome).resolves.toEqual({
        kind: 'fulfilled',
        value: existingPath,
      });
      expect(statNativeAttachmentCacheFile).toHaveBeenCalledWith(existingPath);
      expect(exists).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(await getAttachmentCacheEntry(db, existingPath)).toMatchObject({
        state: 'active',
        bytes: 1_000,
        lastUsedAt: expect.any(Number),
      });
      expect((await getAttachmentCacheEntry(db, existingPath))?.lastUsedAt).toBeGreaterThan(1);
      expect(
        raw.prepare("SELECT value FROM kv WHERE key = 'cache-reuse-neighbour'").get(),
      ).toBeUndefined();
    } finally {
      releaseNeighbour();
      await Promise.allSettled([neighbour?.outcome ?? Promise.resolve(), reused.outcome]);
      raw.close();
    }
  });

  it('revokes queued production reuse without writes and lets a fresh generation retry', async () => {
    const { db, raw } = await createTestDb();
    activeDb = db;
    await recoverAttachmentCache(db, captureRealtimeDeliveryLease());
    const attachment = await seedRcsAttachment(db);
    const existingPath =
      'file:///documents/attachments/media-scope-attachment/generation-1/media-reuse-revoke.jpg';
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: existingPath, bytes: 999, lastUsedAt: 1 }),
    );
    await updateAttachmentLocalPath(db, attachment.guid, existingPath);
    const fetch = jest.fn(async () => ({ localPath: existingPath, bytes: 1_000 }));
    setAttachmentFetcher({
      exists: () => false,
      destinationUri: () => existingPath,
      download: fetch,
    });

    let releaseNeighbour!: () => void;
    const neighbourGate = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    let neighbourStarted = false;
    let neighbour: ReturnType<typeof observe<void>> | undefined;
    let transactionAtStat: boolean | undefined;
    jest
      .mocked(statNativeAttachmentCacheFile)
      .mockImplementationOnce(async () => {
        transactionAtStat = raw.inTransaction;
        neighbour = observe(
          withDbTransaction(db, async (_context) => {
            raw.prepare("INSERT INTO kv (key, value) VALUES ('cache-reuse-revoke', 'dirty')").run();
            neighbourStarted = true;
            await neighbourGate;
            throw new Error('cache reuse revocation neighbour rollback');
          }),
        );
        return { exists: true, bytes: 1_000 };
      })
      .mockResolvedValueOnce({ exists: true, bytes: 1_001 });
    const staleReuse = observe(
      download(
        { ...attachment, localPath: existingPath },
        'manual',
        captureRealtimeDeliveryLease(),
      ),
    );
    let pause: ReturnType<typeof observe<void>> | undefined;
    let freshReuse: ReturnType<typeof observe<string | null>> | undefined;

    try {
      await waitFor(() => neighbourStarted, 'cache reuse revocation neighbour');
      expect(transactionAtStat).toBe(false);
      expect(staleReuse.settled()).toBe(false);
      expect(fetch).not.toHaveBeenCalled();

      await new Promise<void>((resolve) => setImmediate(resolve));
      pause = observe(pauseRealtimeDeliveries());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(pause.settled()).toBe(false);

      releaseNeighbour();
      await expect(neighbour?.outcome).resolves.toMatchObject({ kind: 'rejected' });
      await expect(staleReuse.outcome).resolves.toEqual({ kind: 'fulfilled', value: null });
      await expect(pause.outcome).resolves.toEqual({ kind: 'fulfilled', value: undefined });
      expect(fetch).not.toHaveBeenCalled();
      expect(await getAttachmentCacheEntry(db, existingPath)).toMatchObject({
        state: 'active',
        bytes: 999,
        lastUsedAt: 1,
      });
      expect((await getAttachmentByGuid(db, attachment.guid))?.localPath).toBe(existingPath);
      expect(
        raw.prepare("SELECT value FROM kv WHERE key = 'cache-reuse-revoke'").get(),
      ).toBeUndefined();

      resumeRealtimeDeliveries();
      jest
        .mocked(getNativeAttachmentCacheAvailableBytes)
        .mockResolvedValueOnce(Number.MAX_SAFE_INTEGER);
      await recoverAttachmentCache(db, captureRealtimeDeliveryLease(), {
        scan: async () => [{ uri: existingPath, bytes: 999, mtimeMs: 1 }],
      });
      expect(await getAttachmentCacheEntry(db, existingPath)).toMatchObject({
        state: 'active',
        bytes: 999,
      });
      expect((await getAttachmentByGuid(db, attachment.guid))?.localPath).toBe(existingPath);
      freshReuse = observe(
        download(
          { ...attachment, localPath: existingPath },
          'manual',
          captureRealtimeDeliveryLease(),
        ),
      );
      await expect(freshReuse.outcome).resolves.toEqual({
        kind: 'fulfilled',
        value: existingPath,
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(statNativeAttachmentCacheFile).toHaveBeenCalledTimes(2);
      expect(await getAttachmentCacheEntry(db, existingPath)).toMatchObject({
        state: 'active',
        bytes: 1_001,
      });
    } finally {
      releaseNeighbour();
      await Promise.allSettled([
        neighbour?.outcome ?? Promise.resolve(),
        staleReuse.outcome,
        pause?.outcome ?? Promise.resolve(),
        freshReuse?.outcome ?? Promise.resolve(),
      ]);
      raw.close();
    }
  });

  it('drains queued production retirement settlement before account teardown', async () => {
    const { db, raw } = await createTestDb();
    activeDb = db;
    await recoverAttachmentCache(db, captureRealtimeDeliveryLease());
    const attachment = await seedRcsAttachment(db);
    const retiringPath =
      'file:///documents/attachments/media-retirement-victim/generation-1/media-old.jpg';
    const destinationPath =
      'file:///documents/attachments/media-scope-attachment/generation-1/media-retirement-new.jpg';
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, {
        path: retiringPath,
        bytes: ATTACHMENT_CACHE_MAX_BYTES,
        lastUsedAt: 1,
      }),
    );
    jest.mocked(getNativeAttachmentCacheAvailableBytes).mockResolvedValue(Number.MAX_SAFE_INTEGER);
    const fetch = jest.fn(async () => ({ localPath: destinationPath, bytes: 1_000 }));
    setAttachmentFetcher({
      exists: () => false,
      destinationUri: () => destinationPath,
      download: fetch,
    });

    let releaseNeighbour!: () => void;
    const neighbourGate = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    let neighbourStarted = false;
    let neighbour: ReturnType<typeof observe<void>> | undefined;
    let transactionAtDelete: boolean | undefined;
    jest
      .mocked(deleteNativeAttachmentCacheFile)
      .mockImplementationOnce(async () => {
        transactionAtDelete = raw.inTransaction;
        neighbour = observe(
          withDbTransaction(db, async (_context) => {
            raw
              .prepare("INSERT INTO kv (key, value) VALUES ('cache-settlement-revoke', 'dirty')")
              .run();
            neighbourStarted = true;
            await neighbourGate;
            throw new Error('cache settlement revocation neighbour rollback');
          }),
        );
        return { status: 'deleted', bytes: ATTACHMENT_CACHE_MAX_BYTES };
      })
      .mockResolvedValueOnce({ status: 'missing', bytes: 0 });
    const staleDownload = observe(download(attachment, 'manual', captureRealtimeDeliveryLease()));
    let pause: ReturnType<typeof observe<void>> | undefined;

    try {
      await waitFor(() => neighbourStarted, 'production settlement revocation neighbour');
      expect(transactionAtDelete).toBe(false);
      expect(staleDownload.settled()).toBe(false);
      expect(fetch).not.toHaveBeenCalled();

      await new Promise<void>((resolve) => setImmediate(resolve));
      pause = observe(pauseRealtimeDeliveries());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(pause.settled()).toBe(false);

      releaseNeighbour();
      await expect(neighbour?.outcome).resolves.toMatchObject({ kind: 'rejected' });
      await expect(staleDownload.outcome).resolves.toEqual({ kind: 'fulfilled', value: null });
      await expect(pause.outcome).resolves.toEqual({ kind: 'fulfilled', value: undefined });
      expect(fetch).not.toHaveBeenCalled();
      expect(await getAttachmentCacheEntry(db, retiringPath)).toMatchObject({
        state: 'retiring',
        bytes: ATTACHMENT_CACHE_MAX_BYTES,
        attempts: 0,
        nextRetryAt: 0,
      });
      expect(await getAttachmentCacheEntry(db, destinationPath)).toBeNull();
      expect((await getAttachmentByGuid(db, attachment.guid))?.localPath).toBeNull();
      expect(
        raw.prepare("SELECT value FROM kv WHERE key = 'cache-settlement-revoke'").get(),
      ).toBeUndefined();

      resumeRealtimeDeliveries();
      await expect(
        recoverAttachmentCache(db, captureRealtimeDeliveryLease(), { scan: async () => [] }),
      ).resolves.toMatchObject({ status: 'ready', retiredFiles: 1 });
      expect(deleteNativeAttachmentCacheFile).toHaveBeenCalledTimes(2);
      expect(deleteNativeAttachmentCacheFile).toHaveBeenNthCalledWith(1, retiringPath);
      expect(deleteNativeAttachmentCacheFile).toHaveBeenNthCalledWith(2, retiringPath);
      expect(await getAttachmentCacheEntry(db, retiringPath)).toBeNull();
    } finally {
      releaseNeighbour();
      await Promise.allSettled([
        neighbour?.outcome ?? Promise.resolve(),
        staleDownload.outcome,
        pause?.outcome ?? Promise.resolve(),
      ]);
      raw.close();
    }
  });

  it.each(['due-list', 'post-gate recheck'] as const)(
    'drains a queued retirement %s owner before account teardown',
    async (phase) => {
      const { db, raw } = await createTestDb();
      activeDb = db;
      const retiringPath =
        phase === 'due-list'
          ? 'file:///documents/attachments/media-drain-due-owner/generation-1/media-old.jpg'
          : 'file:///documents/attachments/media-drain-recheck-owner/generation-1/media-old.jpg';
      await withDbTransaction(db, (context) =>
        createAttachmentCacheReservation(context, {
          path: retiringPath,
          maxBytes: 1,
          createdAt: 1,
        }),
      );
      const deleteFile = jest.fn(async () => ({ status: 'deleted' as const, bytes: 1 }));
      const coordinator = new AttachmentCacheCoordinator(
        {
          getAvailableBytes: jest.fn(async () => Number.MAX_SAFE_INTEGER),
          statFile: jest.fn(async () => ({ exists: true, bytes: 1 })),
          deleteFile,
        },
        () => 10_000,
      );
      const staleLease = captureRealtimeDeliveryLease();
      const staleScope = createAttachmentCacheAccountScope(staleLease);
      const neighbourKey =
        phase === 'due-list' ? 'cache-drain-due-neighbour' : 'cache-drain-recheck-neighbour';
      let neighbour: RollingBackDbNeighbour | undefined;
      let sawDueList = false;
      type All = (...args: Parameters<AppDatabase['all']>) => ReturnType<AppDatabase['all']>;
      const realAll = db.all.bind(db) as All;
      const allSpy = jest.spyOn(db, 'all').mockImplementation(((...args) => {
        const shape = JSON.stringify(args[0]).replace(/\s+/g, ' ').toLowerCase();
        if (
          shape.includes('attachment_cache_entries') &&
          shape.includes("state in ('reserved', 'retiring')") &&
          shape.includes('order by next_retry_at')
        ) {
          sawDueList = true;
          expect(raw.inTransaction).toBe(true);
          if (phase === 'post-gate recheck' && !neighbour) {
            // Claim the next queue slot while the due-list owner is still open. The exact-path
            // recheck must register with account teardown before waiting behind this neighbour.
            neighbour = holdRollingBackDbNeighbour(
              db,
              () => {
                raw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(neighbourKey, 'dirty');
              },
              'cache drain recheck neighbour rollback',
            );
          }
        }
        return realAll(...args);
      }) as AppDatabase['all']);
      type RetirementDrainResult = Awaited<
        ReturnType<AttachmentCacheCoordinator['drainDueRetirements']>
      >;
      let staleDrain: ReturnType<typeof observe<RetirementDrainResult>> | undefined;
      let pause: ReturnType<typeof observe<void>> | undefined;

      try {
        if (phase === 'due-list') {
          neighbour = holdRollingBackDbNeighbour(
            db,
            () => {
              raw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(neighbourKey, 'dirty');
            },
            'cache drain due-list neighbour rollback',
          );
          await neighbour.entered;
        }

        staleDrain = observe(coordinator.drainDueRetirements(db, { scope: staleScope }));
        if (phase === 'post-gate recheck') {
          await waitFor(() => neighbour !== undefined, 'queued cache retirement recheck neighbour');
          await neighbour!.entered;
          expect(sawDueList).toBe(true);
          // Let the drain continuation claim its recheck slot behind the held neighbour.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }

        pause = observe(pauseRealtimeDeliveries());
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(staleDrain.settled()).toBe(false);
        expect(pause.settled()).toBe(false);
        expect(deleteFile).not.toHaveBeenCalled();

        neighbour!.release();
        await expect(neighbour!.outcome).resolves.toMatchObject({ status: 'rolled-back' });
        await expect(staleDrain.outcome).resolves.toEqual({
          kind: 'fulfilled',
          value: {
            status: 'stale',
            attempted: 0,
            confirmed: 0,
            failed: 0,
            skipped: 0,
          },
        });
        await expect(pause.outcome).resolves.toEqual({ kind: 'fulfilled', value: undefined });
        expect(deleteFile).not.toHaveBeenCalled();
        expect(await getAttachmentCacheEntry(db, retiringPath)).toMatchObject({
          state: 'reserved',
          attempts: 0,
          nextRetryAt: 0,
        });
        expect(sawDueList).toBe(phase === 'post-gate recheck');
        expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(neighbourKey)).toBeUndefined();

        resumeRealtimeDeliveries();
        const freshScope = createAttachmentCacheAccountScope(captureRealtimeDeliveryLease());
        await expect(coordinator.drainDueRetirements(db, { scope: freshScope })).resolves.toEqual({
          status: 'complete',
          attempted: 1,
          confirmed: 1,
          failed: 0,
          skipped: 0,
        });
        expect(deleteFile).toHaveBeenCalledTimes(1);
        expect(deleteFile).toHaveBeenCalledWith(retiringPath);
        expect(await getAttachmentCacheEntry(db, retiringPath)).toBeNull();
      } finally {
        allSpy.mockRestore();
        await neighbour?.cleanup();
        await Promise.allSettled([
          staleDrain?.outcome ?? Promise.resolve(),
          pause?.outcome ?? Promise.resolve(),
        ]);
        resumeRealtimeDeliveries();
        raw.close();
      }
    },
  );

  it('rejects queued production retry settlement after revocation, then fresh recovery persists it', async () => {
    const { db, raw } = await createTestDb();
    activeDb = db;
    await recoverAttachmentCache(db, captureRealtimeDeliveryLease());
    const attachment = await seedRcsAttachment(db);
    const retiringPath =
      'file:///documents/attachments/media-retirement-retry/generation-1/media-old.jpg';
    const destinationPath =
      'file:///documents/attachments/media-scope-attachment/generation-1/media-retirement-retry.jpg';
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, {
        path: retiringPath,
        bytes: ATTACHMENT_CACHE_MAX_BYTES,
        lastUsedAt: 1,
      }),
    );
    jest.mocked(getNativeAttachmentCacheAvailableBytes).mockResolvedValue(Number.MAX_SAFE_INTEGER);
    const fetch = jest.fn(async () => ({ localPath: destinationPath, bytes: 1_000 }));
    setAttachmentFetcher({
      exists: () => false,
      destinationUri: () => destinationPath,
      download: fetch,
    });

    let releaseNeighbour!: () => void;
    const neighbourGate = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    let neighbourStarted = false;
    let neighbour: ReturnType<typeof observe<void>> | undefined;
    let transactionAtDelete: boolean | undefined;
    jest
      .mocked(deleteNativeAttachmentCacheFile)
      .mockImplementationOnce(async () => {
        transactionAtDelete = raw.inTransaction;
        neighbour = observe(
          withDbTransaction(db, async (_context) => {
            raw.prepare("INSERT INTO kv (key, value) VALUES ('cache-retry-revoke', 'dirty')").run();
            neighbourStarted = true;
            await neighbourGate;
            throw new Error('cache retry revocation neighbour rollback');
          }),
        );
        throw new Error('native retry delete failed');
      })
      .mockRejectedValueOnce(new Error('native retry still failed'));
    const staleDownload = observe(download(attachment, 'manual', captureRealtimeDeliveryLease()));
    let pause: ReturnType<typeof observe<void>> | undefined;

    try {
      await waitFor(() => neighbourStarted, 'production retry revocation neighbour');
      expect(transactionAtDelete).toBe(false);
      expect(staleDownload.settled()).toBe(false);
      expect(fetch).not.toHaveBeenCalled();

      await new Promise<void>((resolve) => setImmediate(resolve));
      pause = observe(pauseRealtimeDeliveries());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(pause.settled()).toBe(false);

      releaseNeighbour();
      await expect(neighbour?.outcome).resolves.toMatchObject({ kind: 'rejected' });
      await expect(staleDownload.outcome).resolves.toEqual({ kind: 'fulfilled', value: null });
      await expect(pause.outcome).resolves.toEqual({ kind: 'fulfilled', value: undefined });
      expect(fetch).not.toHaveBeenCalled();
      expect(await getAttachmentCacheEntry(db, retiringPath)).toMatchObject({
        state: 'retiring',
        bytes: ATTACHMENT_CACHE_MAX_BYTES,
        attempts: 0,
        nextRetryAt: 0,
      });
      expect(await getAttachmentCacheEntry(db, destinationPath)).toBeNull();
      expect((await getAttachmentByGuid(db, attachment.guid))?.localPath).toBeNull();
      expect(
        raw.prepare("SELECT value FROM kv WHERE key = 'cache-retry-revoke'").get(),
      ).toBeUndefined();

      resumeRealtimeDeliveries();
      const retryStartedAt = Date.now();
      await expect(
        recoverAttachmentCache(db, captureRealtimeDeliveryLease(), { scan: async () => [] }),
      ).resolves.toMatchObject({ status: 'ready', retiredFiles: 0 });
      expect(deleteNativeAttachmentCacheFile).toHaveBeenCalledTimes(2);
      expect(deleteNativeAttachmentCacheFile).toHaveBeenNthCalledWith(1, retiringPath);
      expect(deleteNativeAttachmentCacheFile).toHaveBeenNthCalledWith(2, retiringPath);
      const scheduled = await getAttachmentCacheEntry(db, retiringPath);
      expect(scheduled).toMatchObject({
        state: 'retiring',
        bytes: ATTACHMENT_CACHE_MAX_BYTES,
        attempts: 1,
        nextRetryAt: expect.any(Number),
      });
      expect(scheduled?.nextRetryAt).toBeGreaterThanOrEqual(retryStartedAt + 5_000);
    } finally {
      releaseNeighbour();
      await Promise.allSettled([
        neighbour?.outcome ?? Promise.resolve(),
        staleDownload.outcome,
        pause?.outcome ?? Promise.resolve(),
      ]);
      raw.close();
    }
  });

  it('does not run an RCS retry timer after Disconnect and a new generation resumes', async () => {
    const { db } = await createTestDb();
    activeDb = db;
    const attachment = await seedRcsAttachment(db);
    const fetch = jest.fn(async () => {
      throw new AttachmentFetchError('missing');
    });
    setAttachmentFetcher({ exists: () => false, download: fetch });
    jest.useFakeTimers();

    await expect(
      download(attachment, 'manual', captureRealtimeDeliveryLease()),
    ).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);

    // Revocation invalidates the timer's captured generation. Reopening admission for a new
    // account must not make that old timer current again.
    const pause = pauseRealtimeDeliveries();
    expect(jest.getTimerCount()).toBe(0);
    await pause;
    resumeRealtimeDeliveries();
    jest.advanceTimersByTime(30_000);
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('supersedes a sleeping retry when a fresh download invocation takes ownership', async () => {
    const { db } = await createTestDb();
    activeDb = db;
    const attachment = await seedRcsAttachment(db);
    const fetch = jest.fn(async () => {
      throw new AttachmentFetchError('missing');
    });
    setAttachmentFetcher({ exists: () => false, download: fetch });
    jest.useFakeTimers();

    await expect(
      download(attachment, 'manual', captureRealtimeDeliveryLease()),
    ).resolves.toBeNull();
    expect(jest.getTimerCount()).toBe(1);

    await expect(
      download(attachment, 'manual', captureRealtimeDeliveryLease()),
    ).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(2_500);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('lets only the fresh owner continue when two invocations share an in-flight failure', async () => {
    const { db } = await createTestDb();
    activeDb = db;
    const attachment = await seedRcsAttachment(db);
    let rejectTransfer!: (error: unknown) => void;
    const transfer = new Promise<never>((_resolve, reject) => {
      rejectTransfer = reject;
    });
    const fetch = jest.fn(() => transfer);
    setAttachmentFetcher({ exists: () => false, download: fetch });
    jest.useFakeTimers();

    const oldOwner = download(attachment, 'manual', captureRealtimeDeliveryLease());
    const freshOwner = download(attachment, 'manual', captureRealtimeDeliveryLease());
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);

    rejectTransfer(new AttachmentFetchError('missing'));
    await expect(Promise.all([oldOwner, freshOwner])).resolves.toEqual([null, null]);
    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(2_500);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('leaves no stale retry after a fresh invocation succeeds', async () => {
    const { db } = await createTestDb();
    activeDb = db;
    const attachment = await seedRcsAttachment(db);
    const firstFetch = jest.fn(async () => {
      throw new AttachmentFetchError('missing');
    });
    setAttachmentFetcher({ exists: () => false, download: firstFetch });
    jest.useFakeTimers();

    await expect(
      download(attachment, 'manual', captureRealtimeDeliveryLease()),
    ).resolves.toBeNull();
    expect(jest.getTimerCount()).toBe(1);

    const successFetch = jest.fn(async () => ({
      localPath: 'file:///attachments/scope-attachment/photo.jpg',
      bytes: 1_000,
    }));
    setAttachmentFetcher({ exists: () => false, download: successFetch });
    await expect(download(attachment, 'manual', captureRealtimeDeliveryLease())).resolves.toBe(
      'file:///attachments/scope-attachment/photo.jpg',
    );
    expect(jest.getTimerCount()).toBe(0);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(successFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['size', new AttachmentFetchError('size')],
    ['timeout', new AttachmentFetchError('timeout')],
    ['unavailable', new AttachmentFetchError('unavailable')],
    ['cancelled', new AttachmentFetchError('cancelled')],
    ['unknown', new Error('opaque native failure')],
  ] as const)('does not retry a terminal %s outcome', async (_name, failure) => {
    const { db } = await createTestDb();
    activeDb = db;
    const attachment = await seedRcsAttachment(db);
    const fetch = jest.fn(async () => {
      throw failure;
    });
    setAttachmentFetcher({ exists: () => false, download: fetch });
    jest.useFakeTimers();

    await expect(
      download(attachment, 'manual', captureRealtimeDeliveryLease()),
    ).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries an explicitly transient RCS network outcome', async () => {
    const { db } = await createTestDb();
    activeDb = db;
    const attachment = await seedRcsAttachment(db);
    const fetch = jest.fn(async () => {
      throw Object.assign(new Error('network'), { reason: 'network' as const });
    });
    setAttachmentFetcher({ exists: () => false, download: fetch });
    jest.useFakeTimers();

    await expect(
      download(attachment, 'manual', captureRealtimeDeliveryLease()),
    ).resolves.toBeNull();
    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(2_500);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry after the attachment row is deleted during a completed transfer', async () => {
    const { db, raw } = await createTestDb();
    activeDb = db;
    const attachment = await seedRcsAttachment(db);
    const discard = jest.fn();
    const fetch = jest.fn(async () => {
      raw.prepare('DELETE FROM attachments WHERE guid = ?').run(attachment.guid);
      return {
        localPath: 'file:///attachments/deleted/photo.jpg',
        bytes: 1_000,
      };
    });
    setAttachmentFetcher({ exists: () => false, download: fetch, discard });
    jest.useFakeTimers();

    await expect(
      download(attachment, 'manual', captureRealtimeDeliveryLease()),
    ).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith('file:///attachments/deleted/photo.jpg');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops a sleeping RCS retry when its message is deleted before the retry commits', async () => {
    const { db, raw } = await createTestDb();
    activeDb = db;
    const attachment = await seedRcsAttachment(db);
    const discard = jest.fn();
    const fetch = jest
      .fn()
      .mockRejectedValueOnce(new AttachmentFetchError('missing'))
      .mockResolvedValueOnce({
        localPath: 'file:///attachments/deleted-while-waiting/photo.jpg',
        bytes: 1_000,
      });
    setAttachmentFetcher({ exists: () => false, download: fetch, discard });
    jest.useFakeTimers();

    await expect(
      download(attachment, 'manual', captureRealtimeDeliveryLease()),
    ).resolves.toBeNull();
    expect(jest.getTimerCount()).toBe(1);

    raw.prepare('UPDATE messages SET date_deleted = ? WHERE guid = ?').run(2, 'scope-message');
    await jest.advanceTimersByTimeAsync(2_500);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(discard).toHaveBeenCalledWith('file:///attachments/deleted-while-waiting/photo.jpg');
    expect(jest.getTimerCount()).toBe(0);
    expect((await getAttachmentByGuid(db, attachment.guid))?.localPath).toBeNull();
  });

  it('does not detach RCS retries from automatic-ingestion byte accounting', async () => {
    const { db } = await createTestDb();
    activeDb = db;
    const attachment = await seedRcsAttachment(db);
    const fetch = jest.fn(async () => {
      throw new AttachmentFetchError('missing');
    });
    setAttachmentFetcher({ exists: () => false, download: fetch });
    jest.useFakeTimers();

    await expect(
      download(attachment, 'automatic', captureRealtimeDeliveryLease()),
    ).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
