import { Attachment, Chat, Message } from '@core/models';
import {
  claimAttachmentCachePathsForRetirement,
  createAttachmentCacheReservation,
  getAttachmentByGuid,
  getAttachmentCacheEntry,
  recordAttachmentCacheEntry,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  ATTACHMENT_IMAGE_MAX_PIXELS,
  AttachmentFetchError,
  DEFAULT_MAX_CONCURRENT_DOWNLOADS,
  MANUAL_ATTACHMENT_MAX_BYTES,
  MANUAL_DOWNLOAD_TIMEOUT_MS,
  cancelAttachmentDownloads,
  ensureDownloaded,
  ensureDownloadedOutcome,
  setMaxConcurrentDownloads,
  type AttachmentDownloadScope,
  type AttachmentFetchRequest,
  type AttachmentFetcher,
} from '@/services/download/downloadService';
import { AttachmentCacheCoordinator } from '@/services/download/attachmentCacheCoordinator';
import {
  ATTACHMENT_CACHE_MAX_BYTES,
  ATTACHMENT_CACHE_MIN_FREE_BYTES,
} from '@/services/download/attachmentCacheQuotaPolicy';
import { AUTO_IMAGE_MAX_BYTES } from '@utils/attachment';
import { createTestDb } from '../support/testDb';

const fetched = (localPath: string, bytes = 1) => ({ localPath, bytes });

async function seedAttachment(db: AppDatabase, guid: string) {
  const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
  const map = await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: [{ address: 'a@x.com' }] })],
    handles,
  );
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: `m-${guid}`,
        dateCreated: 100,
        hasAttachments: true,
        handle: { address: 'a@x.com' },
        attachments: [Attachment.parse({ guid, mimeType: 'image/jpeg', transferName: 'x.jpg' })],
      }),
    ],
    () => map.get('c1')!,
    handles,
  );
}

describe('ensureDownloaded', () => {
  it('downloads, persists localPath, and fires no second fetch when present', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'd1');
    let calls = 0;
    const fetcher: AttachmentFetcher = {
      exists: (p) => p != null,
      download: async () => {
        calls += 1;
        return fetched('file:///docs/d1.jpg');
      },
    };

    const path = await ensureDownloaded(db, fetcher, {
      guid: 'd1',
      transferName: 'x.jpg',
      localPath: null,
    });
    expect(path).toBe('file:///docs/d1.jpg');
    expect((await getAttachmentByGuid(db, 'd1'))?.localPath).toBe('file:///docs/d1.jpg');

    // Already downloaded → no new fetch.
    const again = await ensureDownloaded(db, fetcher, {
      guid: 'd1',
      transferName: 'x.jpg',
      localPath: 'file:///docs/d1.jpg',
    });
    expect(again).toBe('file:///docs/d1.jpg');
    expect(calls).toBe(1);
  });

  it('uses the optional protected cache-reuse boundary instead of fetcher.exists', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'managed-reuse');
    const exists = jest.fn(() => {
      throw new Error('production reuse must not trust Expo File.exists');
    });
    const download = jest.fn(async () => fetched('file:///docs/replacement.jpg'));
    const reuseCache = jest.fn(async () => ({ status: 'hit' as const }));
    const scope: AttachmentDownloadScope = {
      generation: 11,
      isCurrent: () => true,
      runCommit: async (task) => task(),
      reuseCache,
    };

    await expect(
      ensureDownloadedOutcome(
        db,
        { exists, download },
        {
          guid: 'managed-reuse',
          transferName: 'photo.jpg',
          localPath: 'file:///docs/managed-reuse.jpg',
        },
        undefined,
        scope,
      ),
    ).resolves.toEqual({
      status: 'success',
      localPath: 'file:///docs/managed-reuse.jpg',
      bytes: null,
    });
    expect(reuseCache).toHaveBeenCalledWith('file:///docs/managed-reuse.jpg');
    expect(exists).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('continues to a replacement download after protected cache repair reports missing', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'managed-missing');
    const exists = jest.fn(() => true);
    const download = jest.fn(async () => fetched('file:///docs/managed-missing.jpg', 20));
    const scope: AttachmentDownloadScope = {
      generation: 12,
      isCurrent: () => true,
      runCommit: async (task) => task(),
      reuseCache: async () => ({ status: 'missing' }),
    };

    await expect(
      ensureDownloadedOutcome(
        db,
        { exists, download },
        {
          guid: 'managed-missing',
          transferName: 'photo.jpg',
          localPath: 'file:///docs/old-missing.jpg',
        },
        undefined,
        scope,
      ),
    ).resolves.toEqual({
      status: 'success',
      localPath: 'file:///docs/managed-missing.jpg',
      bytes: 20,
    });
    expect(exists).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledTimes(1);
    expect((await getAttachmentByGuid(db, 'managed-missing'))?.localPath).toBe(
      'file:///docs/managed-missing.jpg',
    );
  });

  it.each(['busy', 'stale', 'unavailable'] as const)(
    'fails closed on a protected cache %s result without starting native download',
    async (status) => {
      const { db } = await createTestDb();
      await seedAttachment(db, `managed-${status}`);
      const download = jest.fn(async () => fetched('file:///docs/should-not-run.jpg'));
      const scope: AttachmentDownloadScope = {
        generation: 13,
        isCurrent: () => true,
        runCommit: async (task) => task(),
        reuseCache: async () => ({ status }),
      };

      await expect(
        ensureDownloadedOutcome(
          db,
          { exists: () => true, download },
          {
            guid: `managed-${status}`,
            transferName: 'photo.jpg',
            localPath: `file:///docs/managed-${status}.jpg`,
          },
          undefined,
          scope,
        ),
      ).resolves.toEqual({ status });
      expect(download).not.toHaveBeenCalled();
    },
  );

  it('adds a native decoded-pixel cap only for attachments the UI will render as images', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'pixel-capped-image');
    await seedAttachment(db, 'pixel-uncapped-document');
    const requests: Array<AttachmentFetchRequest | undefined> = [];
    const download = jest.fn(async (...args: Parameters<AttachmentFetcher['download']>) => {
      requests.push(args[5]);
      return fetched(`file:///docs/${args[0]}`);
    });
    const fetcher: AttachmentFetcher = { exists: () => false, download };

    await ensureDownloaded(db, fetcher, {
      guid: 'pixel-capped-image',
      transferName: 'photo.jpg',
      localPath: null,
      mimeType: 'image/jpeg',
    });
    await ensureDownloaded(db, fetcher, {
      guid: 'pixel-uncapped-document',
      transferName: 'report.pdf',
      localPath: null,
      mimeType: 'application/pdf',
    });

    expect(requests[0]).toEqual(
      expect.objectContaining({ maxImagePixels: ATTACHMENT_IMAGE_MAX_PIXELS }),
    );
    expect(requests[1]).not.toHaveProperty('maxImagePixels');
  });

  it('dedupes concurrent downloads of the same guid', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'd2');
    let calls = 0;
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return fetched('file:///docs/d2.jpg');
      },
    };
    const [a, b] = await Promise.all([
      ensureDownloaded(db, fetcher, { guid: 'd2', transferName: 'x', localPath: null }),
      ensureDownloaded(db, fetcher, { guid: 'd2', transferName: 'x', localPath: null }),
    ]);
    expect(a).toBe('file:///docs/d2.jpg');
    expect(b).toBe('file:///docs/d2.jpg');
    expect(calls).toBe(1); // single fetch
  });

  it('fans progress and verified bytes out to every caller joining a compatible flight', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'joined-observers');
    let emitProgress!: (loaded: number, total: number) => void;
    let complete!: (result: ReturnType<typeof fetched>) => void;
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: jest.fn(
        (_guid, _name, onProgress) =>
          new Promise((resolve) => {
            emitProgress = (loaded, total) => onProgress?.(loaded, total);
            complete = resolve;
          }),
      ),
    };
    const firstProgress: Array<[number, number]> = [];
    const secondProgress: Array<[number, number]> = [];
    const firstBytes = jest.fn();
    const secondBytes = jest.fn();
    const target = {
      guid: 'joined-observers',
      transferName: 'photo.jpg',
      localPath: null,
      totalBytes: 100,
    };

    const first = ensureDownloadedOutcome(
      db,
      fetcher,
      target,
      (loaded, total) => firstProgress.push([loaded, total]),
      undefined,
      'automatic',
      firstBytes,
    );
    const second = ensureDownloadedOutcome(
      db,
      fetcher,
      target,
      (loaded, total) => secondProgress.push([loaded, total]),
      undefined,
      'automatic',
      secondBytes,
    );
    for (let i = 0; i < 10 && complete == null; i += 1) await Promise.resolve();

    emitProgress(50, 100);
    complete(fetched('file:///docs/joined-observers.jpg', 100));

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'success', localPath: 'file:///docs/joined-observers.jpg', bytes: 100 },
      { status: 'success', localPath: 'file:///docs/joined-observers.jpg', bytes: 100 },
    ]);
    expect(fetcher.download).toHaveBeenCalledTimes(1);
    expect(firstProgress).toEqual([[50, 100]]);
    expect(secondProgress).toEqual([[50, 100]]);
    expect(firstBytes).toHaveBeenCalledWith(100);
    expect(secondBytes).toHaveBeenCalledWith(100);
  });

  it('does not start a second same-destination flight for a stricter automatic caller', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'strict-flight');
    let finishManual!: (result: ReturnType<typeof fetched>) => void;
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: jest.fn(
        () =>
          new Promise((resolve) => {
            finishManual = resolve;
          }),
      ),
    };
    const target = {
      guid: 'strict-flight',
      transferName: 'photo.jpg',
      localPath: null,
      totalBytes: 100,
    };
    const manual = ensureDownloadedOutcome(db, fetcher, target);
    const automatic = ensureDownloadedOutcome(
      db,
      fetcher,
      target,
      undefined,
      undefined,
      'automatic',
    );
    for (let i = 0; i < 10 && finishManual == null; i += 1) await Promise.resolve();

    await expect(automatic).resolves.toEqual({ status: 'busy' });
    expect(fetcher.download).toHaveBeenCalledTimes(1);

    finishManual(fetched('file:///docs/strict-manual.jpg', 100));
    await expect(manual).resolves.toEqual({
      status: 'success',
      localPath: 'file:///docs/strict-manual.jpg',
      bytes: 100,
    });
  });

  it('forwards byte progress from the fetcher to the caller onProgress', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'dp');
    const seen: Array<[number, number]> = [];
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: async (_g, _n, onProgress) => {
        onProgress?.(50, 100);
        onProgress?.(100, 100);
        return fetched('file:///docs/dp.jpg', 100);
      },
    };
    await ensureDownloaded(
      db,
      fetcher,
      { guid: 'dp', transferName: 'x', localPath: null },
      (loaded, total) => seen.push([loaded, total]),
    );
    expect(seen).toEqual([
      [50, 100],
      [100, 100],
    ]);
  });

  // A nameless attachment (RCS-bridged media can arrive with none) used to be saved as the bare
  // guid — a file name with no dot, which expo-media-library refuses to save to the gallery.
  it('names a nameless attachment from its MIME type, not the bare guid', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'dn');
    const names: string[] = [];
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: async (_g, name) => {
        names.push(name);
        return fetched('file:///docs/dn.jpg');
      },
    };
    await ensureDownloaded(db, fetcher, {
      guid: 'dn',
      transferName: null,
      localPath: null,
      mimeType: 'image/jpeg',
    });
    expect(names).toEqual(['dn.jpg']);
  });

  it('returns null on fetch failure (no localPath written)', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'd3');
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: async () => {
        throw new Error('network');
      },
    };
    expect(
      await ensureDownloaded(db, fetcher, { guid: 'd3', transferName: 'x', localPath: null }),
    ).toBeNull();
    expect((await getAttachmentByGuid(db, 'd3'))?.localPath).toBeNull();
  });

  it.each([
    ['missing', new AttachmentFetchError('missing'), 'missing'],
    ['network', { reason: 'network' }, 'transient'],
    ['size', new AttachmentFetchError('size'), 'size'],
    ['timeout', new AttachmentFetchError('timeout'), 'timeout'],
    ['unavailable', new AttachmentFetchError('unavailable'), 'unavailable'],
    ['cancelled', new AttachmentFetchError('cancelled'), 'cancelled'],
    ['unknown', new Error('opaque native failure'), 'unavailable'],
  ] as const)('preserves the %s fetch outcome', async (_name, failure, expected) => {
    const { db } = await createTestDb();
    const guid = `typed-${expected}-${String(_name)}`;
    await seedAttachment(db, guid);
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: jest.fn(async () => {
        throw failure;
      }),
    };

    await expect(
      ensureDownloadedOutcome(db, fetcher, { guid, transferName: 'x', localPath: null }),
    ).resolves.toEqual({ status: expected });
  });

  it('returns deleted and discards the file when its attachment row vanished during transfer', async () => {
    const { db, raw } = await createTestDb();
    await seedAttachment(db, 'deleted-during-download');
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: jest.fn(async () => {
        raw.prepare('DELETE FROM attachments WHERE guid = ?').run('deleted-during-download');
        return fetched('file:///docs/deleted-during-download.jpg', 20);
      }),
      discard: jest.fn(),
    };

    await expect(
      ensureDownloadedOutcome(db, fetcher, {
        guid: 'deleted-during-download',
        transferName: 'photo.jpg',
        localPath: null,
      }),
    ).resolves.toEqual({ status: 'deleted' });

    expect(fetcher.discard).toHaveBeenCalledWith('file:///docs/deleted-during-download.jpg');
  });

  it('reserves before native work and commits verified bytes with localPath atomically', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'quota-success');
    const finalPath =
      'file:///documents/attachments/media-quota-success/generation-9/media-photo.jpg';
    const release = jest.fn(async () => undefined);
    const beginProtectionHandoff = jest.fn(() => true);
    const rollbackProtectionHandoff = jest.fn(() => true);
    const reserveCache = jest.fn(async (_path: string, maxBytes: number) => {
      await withDbTransaction(db, (context) =>
        createAttachmentCacheReservation(context, {
          path: finalPath,
          maxBytes,
          createdAt: 1,
        }),
      );
      return {
        status: 'reserved' as const,
        reservation: {
          path: finalPath,
          maxBytes,
          generation: 9 as const,
          beginProtectionHandoff,
          rollbackProtectionHandoff,
          release,
        },
      };
    });
    const download = jest.fn(async () => fetched(finalPath, 20));
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      destinationUri: () => finalPath,
      download,
    };
    const scope: AttachmentDownloadScope = {
      generation: 9,
      isCurrent: () => true,
      runCommit: (task) => task(),
      reserveCache,
    };

    await expect(
      ensureDownloadedOutcome(
        db,
        fetcher,
        {
          guid: 'quota-success',
          transferName: 'photo.jpg',
          localPath: null,
          totalBytes: 100,
        },
        undefined,
        scope,
      ),
    ).resolves.toEqual({ status: 'success', localPath: finalPath, bytes: 20 });

    expect(reserveCache).toHaveBeenCalledWith(finalPath, MANUAL_ATTACHMENT_MAX_BYTES);
    expect(reserveCache.mock.invocationCallOrder[0]).toBeLessThan(
      download.mock.invocationCallOrder[0]!,
    );
    expect((await getAttachmentByGuid(db, 'quota-success'))?.localPath).toBe(finalPath);
    expect(await getAttachmentCacheEntry(db, finalPath)).toMatchObject({
      path: finalPath,
      bytes: 20,
      state: 'active',
    });
    expect(beginProtectionHandoff).toHaveBeenCalledTimes(1);
    expect(rollbackProtectionHandoff).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('opens the exact reservation protection handoff before the localPath write can flush', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'quota-protection-handoff');
    const finalPath =
      'file:///documents/attachments/media-quota-protection-handoff/generation-91/media-photo.jpg';
    const coordinator = new AttachmentCacheCoordinator({
      getAvailableBytes: async () => ATTACHMENT_CACHE_MIN_FREE_BYTES + ATTACHMENT_CACHE_MAX_BYTES,
      statFile: async () => ({ exists: true, bytes: 20 }),
      deleteFile: async () => ({ status: 'deleted', bytes: 20 }),
    });
    let observeCommitWrites = false;
    let observedLedgerPromotion = false;
    let protectionAtLocalPathWrite: ReturnType<AttachmentCacheCoordinator['protect']> | undefined;
    let protectionBeforePromotion: ReturnType<AttachmentCacheCoordinator['protect']> | undefined;
    const realAll = db.all.bind(db);
    const allSpy = jest.spyOn(db, 'all').mockImplementation(((
      ...args: Parameters<AppDatabase['all']>
    ) => {
      if (observeCommitWrites) {
        if (!observedLedgerPromotion) observedLedgerPromotion = true;
        else if (protectionAtLocalPathWrite === undefined) {
          // The second repository write is updateAttachmentLocalPath. Its op-sqlite adapter may
          // flush reactive UI before this promise resolves, so the pin must already succeed here.
          protectionAtLocalPathWrite = coordinator.protect(finalPath);
        }
      }
      return realAll(...args);
    }) as AppDatabase['all']);
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      destinationUri: () => finalPath,
      download: async () => fetched(finalPath, 20),
    };
    const scope: AttachmentDownloadScope = {
      generation: 91,
      isCurrent: () => true,
      runCommit: (task) => task(),
      reserveCache: async (path, maxBytes) => {
        const admission = await coordinator.reserve(db, { path, maxBytes });
        protectionBeforePromotion = coordinator.protect(path);
        observeCommitWrites = true;
        return admission;
      },
    };

    try {
      await expect(
        ensureDownloadedOutcome(
          db,
          fetcher,
          {
            guid: 'quota-protection-handoff',
            transferName: 'photo.jpg',
            localPath: null,
          },
          undefined,
          scope,
        ),
      ).resolves.toEqual({ status: 'success', localPath: finalPath, bytes: 20 });
    } finally {
      allSpy.mockRestore();
    }

    expect(protectionBeforePromotion).toBeNull();
    expect(observedLedgerPromotion).toBe(true);
    expect(protectionAtLocalPathWrite).not.toBeNull();
    expect(protectionAtLocalPathWrite).toBeDefined();
    protectionAtLocalPathWrite?.release();
  });

  it('rolls localPath back and discards when retirement wins before the cache commit', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'quota-retiring');
    const finalPath =
      'file:///documents/attachments/media-quota-retiring/generation-10/media-photo.jpg';
    await withDbTransaction(db, (context) =>
      recordAttachmentCacheEntry(context, { path: finalPath, bytes: 15, lastUsedAt: 1 }),
    );
    await withDbTransaction(db, async (context) => {
      const claim = await claimAttachmentCachePathsForRetirement(context, [finalPath]);
      expect(claim.status).toBe('claimed');
    });
    const release = jest.fn(async () => undefined);
    const beginProtectionHandoff = jest.fn(() => true);
    const rollbackProtectionHandoff = jest.fn(() => true);
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      destinationUri: () => finalPath,
      download: jest.fn(async () => fetched(finalPath, 20)),
      discard: jest.fn(),
    };
    const scope: AttachmentDownloadScope = {
      generation: 10,
      isCurrent: () => true,
      runCommit: (task) => task(),
      reserveCache: async () => ({
        status: 'reserved',
        reservation: {
          path: finalPath,
          maxBytes: 100,
          generation: 10,
          beginProtectionHandoff,
          rollbackProtectionHandoff,
          release,
        },
      }),
    };

    await expect(
      ensureDownloadedOutcome(
        db,
        fetcher,
        { guid: 'quota-retiring', transferName: 'photo.jpg', localPath: null },
        undefined,
        scope,
      ),
    ).resolves.toEqual({ status: 'busy' });

    expect((await getAttachmentByGuid(db, 'quota-retiring'))?.localPath).toBeNull();
    expect(await getAttachmentCacheEntry(db, finalPath)).toMatchObject({ state: 'retiring' });
    expect(fetcher.discard).toHaveBeenCalledWith(finalPath);
    expect(beginProtectionHandoff).not.toHaveBeenCalled();
    expect(rollbackProtectionHandoff).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rolls an attachment-missing commit back to its durable reservation', async () => {
    const { db, raw } = await createTestDb();
    await seedAttachment(db, 'quota-deleted');
    const finalPath =
      'file:///documents/attachments/media-quota-deleted/generation-11/media-photo.jpg';
    const release = jest.fn(async () => undefined);
    const beginProtectionHandoff = jest.fn(() => true);
    const rollbackProtectionHandoff = jest.fn(() => true);
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      destinationUri: () => finalPath,
      download: jest.fn(async () => {
        raw.prepare('DELETE FROM attachments WHERE guid = ?').run('quota-deleted');
        return fetched(finalPath, 20);
      }),
      discard: jest.fn(),
    };
    const scope: AttachmentDownloadScope = {
      generation: 11,
      isCurrent: () => true,
      runCommit: (task) => task(),
      reserveCache: async (_path, maxBytes) => {
        await withDbTransaction(db, (context) =>
          createAttachmentCacheReservation(context, {
            path: finalPath,
            maxBytes,
            createdAt: 1,
          }),
        );
        return {
          status: 'reserved',
          reservation: {
            path: finalPath,
            maxBytes,
            generation: 11,
            beginProtectionHandoff,
            rollbackProtectionHandoff,
            release,
          },
        };
      },
    };

    await expect(
      ensureDownloadedOutcome(
        db,
        fetcher,
        { guid: 'quota-deleted', transferName: 'photo.jpg', localPath: null },
        undefined,
        scope,
      ),
    ).resolves.toEqual({ status: 'deleted' });

    expect(await getAttachmentCacheEntry(db, finalPath)).toMatchObject({ state: 'reserved' });
    expect(fetcher.discard).toHaveBeenCalledWith(finalPath);
    expect(beginProtectionHandoff).toHaveBeenCalledTimes(1);
    expect(rollbackProtectionHandoff).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('cancels an active generation-owned flight as deleted before it can commit', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'cancel-for-delete');
    let observedSignal: AbortSignal | undefined;
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: jest.fn(
        (_guid, _name, _progress, _service, _generation, limits) =>
          new Promise((_resolve, reject) => {
            observedSignal = limits?.signal;
            limits?.signal.addEventListener('abort', () =>
              reject(new AttachmentFetchError('cancelled')),
            );
          }),
      ),
    };
    const scope: AttachmentDownloadScope = {
      generation: 77,
      isCurrent: () => true,
      runCommit: jest.fn(async (task) => task()),
    };

    const result = ensureDownloadedOutcome(
      db,
      fetcher,
      { guid: 'cancel-for-delete', transferName: 'photo.jpg', localPath: null },
      undefined,
      scope,
    );
    for (let i = 0; i < 10 && observedSignal == null; i += 1) await Promise.resolve();

    cancelAttachmentDownloads(['cancel-for-delete'], 77);

    await expect(result).resolves.toEqual({ status: 'deleted' });
    expect(observedSignal?.aborted).toBe(true);
    expect(scope.runCommit).not.toHaveBeenCalled();
    expect((await getAttachmentByGuid(db, 'cancel-for-delete'))?.localPath).toBeNull();
  });

  it('holds the quota token until an abort-ignoring underlying transfer settles', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'quota-late-cancel');
    const finalPath =
      'file:///documents/attachments/media-quota-late-cancel/generation-79/media-photo.jpg';
    const release = jest.fn(async () => undefined);
    const beginProtectionHandoff = jest.fn(() => true);
    const rollbackProtectionHandoff = jest.fn(() => true);
    let finishTransfer!: () => void;
    let markTransferStarted!: () => void;
    const transferStarted = new Promise<void>((resolve) => {
      markTransferStarted = resolve;
    });
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      destinationUri: () => finalPath,
      download: jest.fn(
        () =>
          new Promise((resolve) => {
            finishTransfer = () => resolve(fetched(finalPath, 20));
            markTransferStarted();
          }),
      ),
      discard: jest.fn(),
    };
    const scope: AttachmentDownloadScope = {
      generation: 79,
      isCurrent: () => true,
      runCommit: (task) => task(),
      reserveCache: async (_path, maxBytes) => {
        await withDbTransaction(db, (context) =>
          createAttachmentCacheReservation(context, {
            path: finalPath,
            maxBytes,
            createdAt: 1,
          }),
        );
        return {
          status: 'reserved',
          reservation: {
            path: finalPath,
            maxBytes,
            generation: 79,
            beginProtectionHandoff,
            rollbackProtectionHandoff,
            release,
          },
        };
      },
    };
    const run = ensureDownloadedOutcome(
      db,
      fetcher,
      { guid: 'quota-late-cancel', transferName: 'photo.jpg', localPath: null },
      undefined,
      scope,
    );
    await transferStarted;

    cancelAttachmentDownloads(['quota-late-cancel'], 79);
    await expect(run).resolves.toEqual({ status: 'deleted' });
    expect(release).not.toHaveBeenCalled();

    finishTransfer();
    for (let i = 0; i < 10 && release.mock.calls.length === 0; i += 1) await Promise.resolve();
    expect(fetcher.discard).toHaveBeenCalledWith(finalPath);
    expect(beginProtectionHandoff).not.toHaveBeenCalled();
    expect(rollbackProtectionHandoff).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps a committed file when row deletion cancellation loses the commit race', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'cancel-after-commit');
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: jest.fn(async () => fetched('file:///docs/cancel-after-commit.jpg', 20)),
      discard: jest.fn(),
    };
    const scope: AttachmentDownloadScope = {
      generation: 78,
      isCurrent: () => true,
      runCommit: jest.fn(async (task) => {
        const committed = await task();
        cancelAttachmentDownloads(['cancel-after-commit'], 78);
        return committed;
      }),
    };

    await expect(
      ensureDownloadedOutcome(
        db,
        fetcher,
        { guid: 'cancel-after-commit', transferName: 'photo.jpg', localPath: null },
        undefined,
        scope,
      ),
    ).resolves.toEqual({
      status: 'success',
      localPath: 'file:///docs/cancel-after-commit.jpg',
      bytes: 20,
    });
    expect(fetcher.discard).not.toHaveBeenCalled();
    expect((await getAttachmentByGuid(db, 'cancel-after-commit'))?.localPath).toBe(
      'file:///docs/cancel-after-commit.jpg',
    );
  });

  it('discards a transfer that finishes after its account generation was revoked', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'stale-download');
    let finishFetch!: (path: string) => void;
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: jest.fn(
        () =>
          new Promise<ReturnType<typeof fetched>>((resolve) => {
            finishFetch = (path) => resolve(fetched(path));
          }),
      ),
      discard: jest.fn(),
    };
    let current = true;
    const scope: AttachmentDownloadScope = {
      generation: 41,
      isCurrent: () => current,
      runCommit: jest.fn(async (task) => {
        await task();
        return true;
      }),
    };

    const result = ensureDownloaded(
      db,
      fetcher,
      { guid: 'stale-download', transferName: 'x.jpg', localPath: null },
      undefined,
      scope,
    );
    for (let i = 0; i < 10 && finishFetch == null; i += 1) await Promise.resolve();
    current = false;
    finishFetch('file:///docs/old-account.jpg');

    await expect(result).resolves.toBeNull();
    expect(fetcher.download).toHaveBeenCalledWith(
      'stale-download',
      'x.jpg',
      expect.any(Function),
      undefined,
      41,
      expect.objectContaining({
        mode: 'manual',
        maxBytes: MANUAL_ATTACHMENT_MAX_BYTES,
        signal: expect.any(Object),
      }),
    );
    expect(scope.runCommit).not.toHaveBeenCalled();
    expect(fetcher.discard).toHaveBeenCalledWith('file:///docs/old-account.jpg');
    expect((await getAttachmentByGuid(db, 'stale-download'))?.localPath).toBeNull();
  });

  it('threads distinct account generations through to the native fetcher', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'generation-download');
    const fetch = jest.fn(
      async (
        _guid: string,
        _name: string,
        _onProgress?: (loaded: number, total: number) => void,
        _service?: string | null,
        generation?: number,
      ) => fetched(`file:///docs/generation-${generation}/photo.jpg`),
    );
    const fetcher: AttachmentFetcher = { exists: () => false, download: fetch };
    const scope = (generation: number): AttachmentDownloadScope => ({
      generation,
      isCurrent: () => true,
      runCommit: async (task) => {
        await task();
        return true;
      },
    });
    const attachment = {
      guid: 'generation-download',
      transferName: 'photo.jpg',
      localPath: null,
    };

    await expect(ensureDownloaded(db, fetcher, attachment, undefined, scope(51))).resolves.toBe(
      'file:///docs/generation-51/photo.jpg',
    );
    await expect(ensureDownloaded(db, fetcher, attachment, undefined, scope(52))).resolves.toBe(
      'file:///docs/generation-52/photo.jpg',
    );

    expect(fetch.mock.calls.map((call) => call[4])).toEqual([51, 52]);
    expect((await getAttachmentByGuid(db, 'generation-download'))?.localPath).toBe(
      'file:///docs/generation-52/photo.jpg',
    );
  });

  it('rejects missing, malformed, and over-cap metadata before automatic network work', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'automatic-preflight');
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: jest.fn(async () => fetched('file:///should-not-exist.jpg')),
    };
    const base = {
      guid: 'automatic-preflight',
      transferName: 'photo.jpg',
      localPath: null,
    };

    for (const totalBytes of [null, Number.NaN, -1, 0, AUTO_IMAGE_MAX_BYTES + 1]) {
      await expect(
        ensureDownloaded(db, fetcher, { ...base, totalBytes }, undefined, undefined, 'automatic'),
      ).resolves.toBeNull();
    }

    expect(fetcher.download).not.toHaveBeenCalled();
    expect((await getAttachmentByGuid(db, 'automatic-preflight'))?.localPath).toBeNull();
  });

  it('rejects metadata over the absolute manual cap before network work', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'manual-preflight');
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: jest.fn(async () => fetched('file:///should-not-exist.jpg')),
    };

    await expect(
      ensureDownloaded(db, fetcher, {
        guid: 'manual-preflight',
        transferName: 'archive.zip',
        localPath: null,
        totalBytes: MANUAL_ATTACHMENT_MAX_BYTES + 1,
      }),
    ).resolves.toBeNull();

    expect(fetcher.download).not.toHaveBeenCalled();
    expect((await getAttachmentByGuid(db, 'manual-preflight'))?.localPath).toBeNull();
  });

  it('passes a tighter caller budget to native work and rejects a result that crosses it', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'caller-budget');
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: jest.fn(async (...args) => {
        expect(args[5]).toEqual(expect.objectContaining({ maxBytes: 50 }));
        return fetched('file:///docs/caller-budget.jpg', 51);
      }),
      discard: jest.fn(),
    };

    await expect(
      ensureDownloaded(
        db,
        fetcher,
        {
          guid: 'caller-budget',
          transferName: 'photo.jpg',
          localPath: null,
          totalBytes: 1,
        },
        undefined,
        undefined,
        'automatic',
        undefined,
        50,
      ),
    ).resolves.toBeNull();

    expect(fetcher.discard).toHaveBeenCalledWith('file:///docs/caller-budget.jpg');
    expect((await getAttachmentByGuid(db, 'caller-budget'))?.localPath).toBeNull();
  });

  it('discards a hostile false-length result whose verified bytes exceed the automatic cap', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'false-length');
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: jest.fn(async () =>
        fetched('file:///docs/false-length.jpg', AUTO_IMAGE_MAX_BYTES + 1),
      ),
      discard: jest.fn(),
    };

    await expect(
      ensureDownloaded(
        db,
        fetcher,
        {
          guid: 'false-length',
          transferName: 'photo.jpg',
          localPath: null,
          totalBytes: 1,
        },
        undefined,
        undefined,
        'automatic',
      ),
    ).resolves.toBeNull();

    expect(fetcher.discard).toHaveBeenCalledWith('file:///docs/false-length.jpg');
    expect((await getAttachmentByGuid(db, 'false-length'))?.localPath).toBeNull();
  });

  it('discards a zero-byte verified result and never commits it', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'empty-result');
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: jest.fn(async () => fetched('file:///docs/empty.jpg', 0)),
      discard: jest.fn(),
    };

    await expect(
      ensureDownloaded(db, fetcher, {
        guid: 'empty-result',
        transferName: 'empty.jpg',
        localPath: null,
        totalBytes: null,
      }),
    ).resolves.toBeNull();

    expect(fetcher.discard).toHaveBeenCalledWith('file:///docs/empty.jpg');
    expect((await getAttachmentByGuid(db, 'empty-result'))?.localPath).toBeNull();
  });

  it('aborts a transfer at its deadline and never commits a localPath', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'timeout-download');
    let observedSignal: AbortSignal | undefined;
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: jest.fn(
        (_guid, _name, _progress, _service, _generation, limits) =>
          new Promise((_resolve, reject) => {
            observedSignal = limits?.signal;
            limits?.signal.addEventListener('abort', () => reject(new Error('cancelled')));
          }),
      ),
      discard: jest.fn(),
    };
    jest.useFakeTimers();
    try {
      const result = ensureDownloadedOutcome(db, fetcher, {
        guid: 'timeout-download',
        transferName: 'large.bin',
        localPath: null,
        totalBytes: null,
      });
      for (let i = 0; i < 10 && observedSignal == null; i += 1) await Promise.resolve();
      expect(observedSignal?.aborted).toBe(false);

      await jest.advanceTimersByTimeAsync(MANUAL_DOWNLOAD_TIMEOUT_MS);
      await expect(result).resolves.toEqual({ status: 'timeout' });

      expect(observedSignal?.aborted).toBe(true);
      expect((await getAttachmentByGuid(db, 'timeout-download'))?.localPath).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('promptly aborts a no-progress transfer after its account generation is revoked', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'revoked-stall');
    let current = true;
    let observedSignal: AbortSignal | undefined;
    const scope: AttachmentDownloadScope = {
      generation: 92,
      isCurrent: () => current,
      runCommit: jest.fn(async () => true),
    };
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: jest.fn(
        (_guid, _name, _progress, _service, _generation, limits) =>
          new Promise((_resolve, reject) => {
            observedSignal = limits?.signal;
            limits?.signal.addEventListener('abort', () => reject(new Error('cancelled')));
          }),
      ),
    };

    jest.useFakeTimers();
    try {
      const run = ensureDownloaded(
        db,
        fetcher,
        { guid: 'revoked-stall', transferName: 'photo.jpg', localPath: null },
        undefined,
        scope,
      );
      for (let i = 0; i < 10 && observedSignal == null; i += 1) await Promise.resolve();
      expect(observedSignal?.aborted).toBe(false);

      current = false;
      await jest.advanceTimersByTimeAsync(100);

      await expect(run).resolves.toBeNull();
      expect(observedSignal?.aborted).toBe(true);
      expect(scope.runCommit).not.toHaveBeenCalled();
      expect((await getAttachmentByGuid(db, 'revoked-stall'))?.localPath).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('discards a verified file when the generation commit guard refuses the DB write', async () => {
    const { db } = await createTestDb();
    await seedAttachment(db, 'refused-commit');
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: jest.fn(async () => fetched('file:///docs/refused-commit.jpg', 10)),
      discard: jest.fn(),
    };
    const scope: AttachmentDownloadScope = {
      generation: 91,
      isCurrent: () => true,
      runCommit: jest.fn(async () => false),
    };

    await expect(
      ensureDownloaded(
        db,
        fetcher,
        {
          guid: 'refused-commit',
          transferName: 'photo.jpg',
          localPath: null,
          totalBytes: 10,
        },
        undefined,
        scope,
      ),
    ).resolves.toBeNull();

    expect(fetcher.discard).toHaveBeenCalledWith('file:///docs/refused-commit.jpg');
    expect((await getAttachmentByGuid(db, 'refused-commit'))?.localPath).toBeNull();
  });

  it('respects the configurable concurrency cap and wakes queued downloads when raised', async () => {
    const { db } = await createTestDb();
    for (const g of ['e1', 'e2', 'e3']) await seedAttachment(db, g);
    let running = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: () =>
        new Promise<ReturnType<typeof fetched>>((resolve) => {
          running += 1;
          peak = Math.max(peak, running);
          gates.push(() => {
            running -= 1;
            resolve(fetched('file:///x.jpg'));
          });
        }),
    };

    try {
      setMaxConcurrentDownloads(1);
      const all = ['e1', 'e2', 'e3'].map((g) =>
        ensureDownloaded(db, fetcher, { guid: g, transferName: 'x', localPath: null }),
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(peak).toBe(1); // cap=1 → only one download runs at a time

      setMaxConcurrentDownloads(3); // raising the cap must wake the two queued downloads
      await new Promise((r) => setTimeout(r, 10));
      expect(peak).toBe(3);

      while (gates.length) gates.shift()!();
      await Promise.all(all);
    } finally {
      setMaxConcurrentDownloads(DEFAULT_MAX_CONCURRENT_DOWNLOADS); // restore shared module state
    }
  });

  it('does not wake a queued download too early when Settings lowers the active cap', async () => {
    const { db } = await createTestDb();
    for (const guid of ['lower-1', 'lower-2', 'lower-3', 'lower-4']) {
      await seedAttachment(db, guid);
    }
    const started: string[] = [];
    const finish = new Map<string, () => void>();
    const fetcher: AttachmentFetcher = {
      exists: () => false,
      download: (guid) =>
        new Promise((resolve) => {
          started.push(guid);
          finish.set(guid, () => resolve(fetched(`file:///${guid}.jpg`)));
        }),
    };

    try {
      setMaxConcurrentDownloads(3);
      const runs = ['lower-1', 'lower-2', 'lower-3', 'lower-4'].map((guid) =>
        ensureDownloaded(db, fetcher, { guid, transferName: 'x.jpg', localPath: null }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(started).toEqual(['lower-1', 'lower-2', 'lower-3']);

      setMaxConcurrentDownloads(1);
      finish.get('lower-1')?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(started).toHaveLength(3);

      finish.get('lower-2')?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(started).toHaveLength(3);

      finish.get('lower-3')?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(started).toEqual(['lower-1', 'lower-2', 'lower-3', 'lower-4']);

      finish.get('lower-4')?.();
      await Promise.all(runs);
    } finally {
      setMaxConcurrentDownloads(DEFAULT_MAX_CONCURRENT_DOWNLOADS);
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'normalizes invalid concurrency value %s to the safe default',
    async (invalid) => {
      const { db } = await createTestDb();
      const guids = [
        `invalid-${String(invalid)}-1`,
        `invalid-${String(invalid)}-2`,
        `invalid-${String(invalid)}-3`,
      ];
      for (const guid of guids) await seedAttachment(db, guid);
      const started: string[] = [];
      const finish: Array<() => void> = [];
      const fetcher: AttachmentFetcher = {
        exists: () => false,
        download: (guid) =>
          new Promise((resolve) => {
            started.push(guid);
            finish.push(() => resolve(fetched(`file:///${guid}.jpg`)));
          }),
      };

      try {
        setMaxConcurrentDownloads(invalid);
        const runs = guids.map((guid) =>
          ensureDownloaded(db, fetcher, { guid, transferName: 'x.jpg', localPath: null }),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(started).toHaveLength(DEFAULT_MAX_CONCURRENT_DOWNLOADS);

        finish.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(started).toHaveLength(3);

        while (finish.length > 0) finish.shift()?.();
        await Promise.all(runs);
      } finally {
        setMaxConcurrentDownloads(DEFAULT_MAX_CONCURRENT_DOWNLOADS);
      }
    },
  );
});
