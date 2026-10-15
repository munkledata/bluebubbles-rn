/**
 * Storage cleanup deletes the least recently used cached file first. A file shown on screen must
 * count as used, or a photo someone keeps opening is deleted before one nobody has looked at since
 * it downloaded (review M145).
 */
/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
import type { AttachmentCacheNativeBoundary } from '@/services/download/attachmentCacheCoordinator';

let mockDb: unknown;
let mockClock = 0;
let mockRecoveryReady = true;
const mockStatFile = jest.fn<ReturnType<AttachmentCacheNativeBoundary['statFile']>, [string]>();
const mockDeleteFile = jest.fn<ReturnType<AttachmentCacheNativeBoundary['deleteFile']>, [string]>();
const mockAvailableBytes = jest.fn<Promise<number>, []>();

jest.mock('@db/database', () => ({ getDatabase: () => mockDb }));
jest.mock('@/services/download/attachmentCacheCoordinator', () => {
  const actual = jest.requireActual<
    typeof import('@/services/download/attachmentCacheCoordinator')
  >('@/services/download/attachmentCacheCoordinator');
  return {
    ...actual,
    attachmentCacheCoordinator: new actual.AttachmentCacheCoordinator(
      {
        getAvailableBytes: () => mockAvailableBytes(),
        statFile: (path: string) => mockStatFile(path),
        deleteFile: (path: string) => mockDeleteFile(path),
      },
      () => mockClock,
    ),
  };
});
jest.mock('@/services/download/attachmentCacheRecovery', () => ({
  isAttachmentCacheRecoveryReady: (lease: { isCurrent(): boolean }) =>
    mockRecoveryReady && lease.isCurrent(),
}));

import { getAttachmentCacheEntry } from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { createAttachmentCacheAccountScope } from '@/services/download/attachmentCacheAccountScope';
import { attachmentCacheCoordinator } from '@/services/download/attachmentCacheCoordinator';
import {
  ATTACHMENT_CACHE_MAX_BYTES,
  ATTACHMENT_CACHE_MIN_FREE_BYTES,
} from '@/services/download/attachmentCacheQuotaPolicy';
import {
  MAX_PENDING_ATTACHMENT_CACHE_VIEWS,
  recordAttachmentCacheView,
} from '@/services/download/attachmentCacheViews';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { createTestDb } from '../support/testDb';
import { recordAttachmentCacheEntry } from '../support/repositoryWrappers';

const NOW = 2_000_000;
const OLD = NOW - 20 * 60 * 1000;
const path = (name: string): string =>
  `file:///documents/attachments/media-${name}/generation-1/media-file.jpg`;

async function seedUsage(
  db: AppDatabase,
  entries: { path: string; bytes: number; lastUsedAt: number }[],
): Promise<void> {
  for (const entry of entries) {
    await withDbTransaction(db, (context) => recordAttachmentCacheEntry(context, entry));
  }
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  mockRecoveryReady = true;
  mockClock = NOW;
  mockStatFile.mockReset().mockResolvedValue({ exists: true, bytes: 10 });
  mockDeleteFile.mockReset().mockResolvedValue({ status: 'deleted', bytes: 10 });
  mockAvailableBytes
    .mockReset()
    .mockResolvedValue(ATTACHMENT_CACHE_MIN_FREE_BYTES + ATTACHMENT_CACHE_MAX_BYTES);
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('keeps a file someone just viewed and cleans up the one nobody opened', async () => {
  const { db, raw } = await createTestDb();
  mockDb = db;
  const viewed = path('viewed');
  const unopened = path('unopened');
  // The viewed file downloaded first, so before the fix it looked like the least recently used.
  await seedUsage(db, [
    { path: viewed, bytes: 10, lastUsedAt: OLD },
    { path: unopened, bytes: 10, lastUsedAt: OLD + 1 },
    { path: path('large'), bytes: ATTACHMENT_CACHE_MAX_BYTES - 25, lastUsedAt: OLD + 2 },
  ]);

  await recordAttachmentCacheView(viewed);
  expect(await getAttachmentCacheEntry(db, viewed)).toMatchObject({
    state: 'active',
    lastUsedAt: NOW,
  });

  // A new download needs room, so cleanup removes one least-recently-used file.
  const admission = await attachmentCacheCoordinator.reserve(db, {
    path: path('incoming'),
    maxBytes: 10,
    scope: createAttachmentCacheAccountScope(captureRealtimeDeliveryLease()),
  });
  expect(admission.status).toBe('reserved');
  expect(mockDeleteFile).toHaveBeenCalledTimes(1);
  expect(mockDeleteFile).toHaveBeenCalledWith(unopened);
  expect(await getAttachmentCacheEntry(db, viewed)).toMatchObject({ state: 'active' });
  if (admission.status === 'reserved') await admission.reservation.release();
  raw.close();
});

it('records a file at most once a minute, and only for the current, checked account', async () => {
  const { db, raw } = await createTestDb();
  mockDb = db;
  const file = path('repeat');
  await seedUsage(db, [{ path: file, bytes: 10, lastUsedAt: OLD }]);
  const wallClock = jest.spyOn(Date, 'now').mockReturnValue(5_000_000);

  // Before startup has checked the cache for this account, a view records nothing.
  mockRecoveryReady = false;
  await recordAttachmentCacheView(file);
  expect(mockStatFile).not.toHaveBeenCalled();
  mockRecoveryReady = true;

  await recordAttachmentCacheView(file);
  await recordAttachmentCacheView(file);
  expect(mockStatFile).toHaveBeenCalledTimes(1);

  wallClock.mockReturnValue(5_000_000 + 60_000);
  await recordAttachmentCacheView(file);
  expect(mockStatFile).toHaveBeenCalledTimes(2);

  // A view captured just before Disconnect must not write into the account being torn down.
  const other = path('disconnect');
  await seedUsage(db, [{ path: other, bytes: 10, lastUsedAt: OLD }]);
  const recorded = recordAttachmentCacheView(other);
  const paused = pauseRealtimeDeliveries();
  await recorded;
  await paused;
  expect(mockStatFile).toHaveBeenCalledTimes(2);
  expect(await getAttachmentCacheEntry(db, other)).toMatchObject({ lastUsedAt: OLD });
  raw.close();
});

it('records one view at a time and skips views beyond the waiting limit', async () => {
  const { db, raw } = await createTestDb();
  mockDb = db;
  let releaseFirstStat!: () => void;
  mockStatFile.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseFirstStat = () => resolve({ exists: true, bytes: 10 });
      }),
  );

  const extra = 6;
  const records = Array.from({ length: MAX_PENDING_ATTACHMENT_CACHE_VIEWS + extra }, (_, index) =>
    recordAttachmentCacheView(path(`burst-${index}`)),
  );
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  // Only the first record is running; the rest wait behind it instead of all statting at once.
  expect(mockStatFile).toHaveBeenCalledTimes(1);

  releaseFirstStat();
  await Promise.all(records);
  expect(mockStatFile).toHaveBeenCalledTimes(MAX_PENDING_ATTACHMENT_CACHE_VIEWS);
  raw.close();
});
