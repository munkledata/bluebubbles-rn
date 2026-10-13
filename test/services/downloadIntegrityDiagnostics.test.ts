jest.mock('expo-application', () => ({
  nativeApplicationVersion: 'test',
  nativeBuildVersion: '1',
}));
jest.mock('react-native', () => ({ Platform: { OS: 'android', Version: 37 } }));
jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@native/boundedDownload', () => ({
  getNativeAttachmentCacheAvailableBytes: jest.fn(),
  inspectNativeBoundedDownloadPartials: jest.fn(),
  inspectNativeSyncedBackgroundCache: jest.fn(),
  scanNativeAttachmentCacheFiles: jest.fn(),
  validateNativeSyncedBackgroundCacheFile: jest.fn(),
}));
jest.mock('@/services/download/attachmentCacheCoordinator', () => ({
  attachmentCacheCoordinator: { diagnosticSnapshot: jest.fn() },
}));
jest.mock('@/services/download/boundedNativeDownload', () => ({
  getBoundedDownloadRuntimeDiagnostics: jest.fn(),
}));
const mockRunTrackedRealtimeWork = jest.fn(
  async (
    lease: { isCurrent(): boolean },
    task: (activeLease: { isCurrent(): boolean }) => Promise<unknown>,
  ) => {
    if (!lease.isCurrent()) return 'paused';
    await task(lease);
    return 'delivered';
  },
);
let mockInvalidationListener: (() => void) | null = null;
const mockUnsubscribeInvalidation = jest.fn(() => {
  mockInvalidationListener = null;
});
const mockSubscribeRealtimeGenerationInvalidation = jest.fn(
  (_generation: number, listener: () => void) => {
    mockInvalidationListener = listener;
    return mockUnsubscribeInvalidation;
  },
);
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  runTrackedRealtimeWork: (...args: Parameters<typeof mockRunTrackedRealtimeWork>) =>
    mockRunTrackedRealtimeWork(...args),
  subscribeRealtimeGenerationInvalidation: (
    ...args: Parameters<typeof mockSubscribeRealtimeGenerationInvalidation>
  ) => mockSubscribeRealtimeGenerationInvalidation(...args),
}));

import type { DownloadIntegrityDbSnapshot } from '@db/repositories/downloadIntegrityDiagnostics';
import {
  collectDownloadIntegrityDiagnostics,
  type DownloadIntegrityDependencies,
} from '@/services/download/downloadIntegrityDiagnostics';

const activePath = 'file:///private/attachments/media-guid/generation-7/media-photo.jpg';
const reservedPath = 'file:///private/attachments/media-next/generation-7/media-next.jpg';
const untrackedLegacyPath = 'file:///private/attachments/legacy-guid/legacy-photo.jpg';
const wallpaperPath = 'file:///private/synced-backgrounds/generation-7/media-current.jpg';

function snapshot(activeFiles = 1): DownloadIntegrityDbSnapshot {
  return {
    counts: {
      migrationCount: 50,
      migrationHead: '0050_message_identity_owner_scope',
      attachments: { rows: 2, localPathRows: 1, distinctLocalPaths: 1 },
      cache: {
        activeFiles,
        activeBytes: 10,
        reservedFiles: 1,
        reservedBytes: 20,
        retiringFiles: 0,
        retiringBytes: 0,
      },
      receipts: {
        pending: 1,
        completed: 0,
        terminal: 0,
        gallery: 1,
        album: 0,
        attempts0: 1,
        attempts1: 0,
        attempts2: 0,
        attempts3: 0,
        leased: 0,
        latestPresent: true,
        latestPending: true,
        latestCompleted: false,
        latestTerminal: false,
        latestGallery: true,
        latestAlbum: false,
        latestLeased: false,
        latestAttempts: 0,
        latestHasLocalPath: false,
      },
      wallpapers: {
        channelRows: 1,
        localPathRows: 1,
        distinctLocalPaths: 1,
        channelWithoutLocalPath: 0,
        localPathWithoutChannel: 0,
      },
    },
    ledger: [
      { path: activePath, bytes: 10, state: 'active' },
      { path: reservedPath, bytes: 20, state: 'reserved' },
    ],
    wallpaperPaths: [wallpaperPath],
  };
}

function dependencies(
  readDbSnapshot: DownloadIntegrityDependencies['readDbSnapshot'] = async () => snapshot(),
): DownloadIntegrityDependencies {
  return {
    readDbSnapshot,
    scanAttachmentCache: async () => [
      { uri: activePath, bytes: 10, mtimeMs: 100 },
      { uri: untrackedLegacyPath, bytes: 5, mtimeMs: 101 },
    ],
    inspectPartials: async () => ({ files: 1, bytes: 0 }),
    inspectWallpapers: async () => ({
      files: 1,
      bytes: 6,
      withinAdmissionLimit: true,
      withinFinalLimit: true,
    }),
    validateWallpaper: async () => true,
    readAvailableBytes: async () => 600 * 1024 * 1024,
    readRuntime: () => ({ activeTransfers: 1, activeDestinations: 1 }),
    readCoordinator: () => ({
      reservations: 1,
      reservedBytes: 20,
      retirementOwners: 0,
      pendingRetirements: 0,
      protectedPaths: 1,
      protectionOwners: 1,
    }),
    readCandidate: () => ({ appVersion: '0.1.54', appBuild: '74', androidApi: '37' }),
  };
}

const currentLease = { generation: 7, isCurrent: () => true };

beforeEach(() => {
  mockRunTrackedRealtimeWork.mockClear();
  mockInvalidationListener = null;
  mockUnsubscribeInvalidation.mockClear();
  mockSubscribeRealtimeGenerationInvalidation.mockClear();
});

it('publishes only fixed aggregate fields from matching DB and native snapshots', async () => {
  const report = await collectDownloadIntegrityDiagnostics(currentLease, dependencies());

  expect(report).toEqual(
    expect.objectContaining({
      databaseAndOwnershipMatched: true,
      downloads: expect.objectContaining({
        activeTransfers: 1,
        activeDestinations: 1,
        partialInspection: 'verified',
        partialFiles: 1,
        partialBytes: 0,
      }),
      cache: expect.objectContaining({
        ledgerFiles: 2,
        ledgerBytes: 30,
        nativeInspection: 'verified',
        nativeFiles: 2,
        nativeBytes: 15,
        activeMissing: 0,
        reservedMissing: 1,
        untrackedNative: 1,
        settledExact: false,
        currentGenerationFiles: 1,
        legacyLayoutFiles: 1,
        freeSpaceFloorMet: true,
      }),
      wallpapers: expect.objectContaining({
        nativeInspection: 'verified',
        referenceInspection: 'verified',
        validReferences: 1,
        invalidOrMissingReferences: 0,
      }),
    }),
  );
  const serialized = JSON.stringify(report);
  expect(serialized).not.toContain(activePath);
  expect(serialized).not.toContain(reservedPath);
  expect(serialized).not.toContain(untrackedLegacyPath);
  expect(serialized).not.toContain(wallpaperPath);
  expect(mockRunTrackedRealtimeWork).toHaveBeenCalledTimes(2);
});

it('classifies hashed identities by account generation without exposing their digest', async () => {
  const deps = dependencies();
  const identity = `id-sha256-${'a'.repeat(64)}`;
  deps.scanAttachmentCache = async () =>
    ['7', '8', 'unscoped'].map((generation) => ({
      uri: `file:///private/attachments/${identity}/generation-${generation}/media-photo.png`,
      bytes: 5,
      mtimeMs: 100,
    }));
  const report = await collectDownloadIntegrityDiagnostics(currentLease, deps);
  expect(report?.cache).toMatchObject({
    nativeFiles: 3,
    currentGenerationFiles: 1,
    foreignGenerationFiles: 1,
    unscopedGenerationFiles: 1,
    legacyLayoutFiles: 0,
  });
  expect(JSON.stringify(report)).not.toContain(identity);
});

it('uses a fixed rejected status and never returns native exception text', async () => {
  const deps = dependencies();
  deps.inspectPartials = async () => {
    throw new Error('PRIVATE-PATH-CANARY');
  };

  const report = await collectDownloadIntegrityDiagnostics(currentLease, deps);

  expect(report?.downloads).toEqual(
    expect.objectContaining({
      partialInspection: 'rejected',
      partialFiles: null,
      partialBytes: null,
    }),
  );
  expect(JSON.stringify(report)).not.toContain('PRIVATE-PATH-CANARY');
});

it('refuses to publish when the encrypted DB changes during inspection', async () => {
  const readDbSnapshot = jest
    .fn<Promise<DownloadIntegrityDbSnapshot>, []>()
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValueOnce(snapshot(2));

  await expect(
    collectDownloadIntegrityDiagnostics(currentLease, dependencies(readDbSnapshot)),
  ).rejects.toThrow('Download integrity state changed during inspection.');
});

it('drops a DB snapshot failure that lands after the account changed', async () => {
  let current = true;
  const lease = { generation: 7, isCurrent: () => current };
  const readDbSnapshot = jest.fn(async (): Promise<DownloadIntegrityDbSnapshot> => {
    current = false;
    throw new Error('database closed by Disconnect');
  });

  await expect(
    collectDownloadIntegrityDiagnostics(lease, dependencies(readDbSnapshot)),
  ).resolves.toBeNull();
});

it('discards native results and cleans up when the account is invalidated mid-scan', async () => {
  const readDbSnapshot = jest.fn(async () => snapshot());
  const deps = dependencies(readDbSnapshot);
  deps.scanAttachmentCache = async () => {
    mockInvalidationListener?.();
    return [];
  };

  await expect(collectDownloadIntegrityDiagnostics(currentLease, deps)).resolves.toBeNull();

  expect(readDbSnapshot).toHaveBeenCalledTimes(1);
  expect(mockRunTrackedRealtimeWork).toHaveBeenCalledTimes(1);
  expect(mockSubscribeRealtimeGenerationInvalidation).toHaveBeenCalledWith(7, expect.any(Function));
  expect(mockUnsubscribeInvalidation).toHaveBeenCalledTimes(1);
});
