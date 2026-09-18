import * as Application from 'expo-application';
import { Platform } from 'react-native';
import { getDatabase } from '@db/database';
import {
  readDownloadIntegrityDbSnapshot,
  type DownloadIntegrityDbSnapshot,
} from '@db/repositories/downloadIntegrityDiagnostics';
import {
  getNativeAttachmentCacheAvailableBytes,
  inspectNativeBoundedDownloadPartials,
  inspectNativeSyncedBackgroundCache,
  scanNativeAttachmentCacheFiles,
  validateNativeSyncedBackgroundCacheFile,
  type AttachmentCacheScanFile,
  type BoundedDownloadPartialsInspection,
  type SyncedBackgroundCacheInspection,
} from '@native/boundedDownload';
import {
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import {
  attachmentCacheCoordinator,
  type AttachmentCacheCoordinatorDiagnostics,
} from './attachmentCacheCoordinator';
import {
  ATTACHMENT_CACHE_MAX_BYTES,
  ATTACHMENT_CACHE_MAX_FILES,
  ATTACHMENT_CACHE_MIN_FREE_BYTES,
} from './attachmentCacheQuotaPolicy';
import {
  getBoundedDownloadRuntimeDiagnostics,
  type BoundedDownloadRuntimeDiagnostics,
} from './boundedNativeDownload';
import { parseAttachmentCacheFileUri, UNSCOPED_MEDIA_GENERATION } from './pathSafety';

const MAX_VALIDATED_WALLPAPER_REFERENCES = 256;

export type DownloadIntegrityInspectionStatus = 'verified' | 'rejected';

export interface DownloadIntegrityCandidateIdentity {
  readonly appVersion: string;
  readonly appBuild: string;
  readonly androidApi: string;
}

export interface DownloadIntegrityReport {
  readonly candidate: DownloadIntegrityCandidateIdentity & {
    readonly migrationCount: number;
    readonly migrationHead: string;
  };
  readonly databaseAndOwnershipMatched: true;
  readonly downloads: {
    readonly activeTransfers: number;
    readonly activeDestinations: number;
    readonly partialInspection: DownloadIntegrityInspectionStatus;
    readonly partialFiles: number | null;
    readonly partialBytes: number | null;
  };
  readonly receipts: DownloadIntegrityDbSnapshot['counts']['receipts'];
  readonly coordinator: AttachmentCacheCoordinatorDiagnostics;
  readonly cache: {
    readonly ledgerFiles: number;
    readonly ledgerBytes: number | null;
    readonly activeFiles: number;
    readonly activeBytes: number;
    readonly reservedFiles: number;
    readonly reservedBytes: number;
    readonly retiringFiles: number;
    readonly retiringBytes: number;
    readonly withinByteLimit: boolean;
    readonly withinFileLimit: boolean;
    readonly nativeInspection: DownloadIntegrityInspectionStatus;
    readonly nativeFiles: number | null;
    readonly nativeBytes: number | null;
    readonly activeMissing: number | null;
    readonly activeByteMismatches: number | null;
    readonly reservedPresent: number | null;
    readonly reservedMissing: number | null;
    readonly retiringPresent: number | null;
    readonly retiringMissing: number | null;
    readonly untrackedNative: number | null;
    readonly settledExact: boolean | null;
    readonly currentGenerationFiles: number | null;
    readonly foreignGenerationFiles: number | null;
    readonly unscopedGenerationFiles: number | null;
    readonly legacyLayoutFiles: number | null;
    readonly freeSpaceInspection: DownloadIntegrityInspectionStatus;
    readonly availableBytes: number | null;
    readonly freeSpaceFloorMet: boolean | null;
  };
  readonly attachments: DownloadIntegrityDbSnapshot['counts']['attachments'];
  readonly wallpapers: DownloadIntegrityDbSnapshot['counts']['wallpapers'] & {
    readonly nativeInspection: DownloadIntegrityInspectionStatus;
    readonly nativeFiles: number | null;
    readonly nativeBytes: number | null;
    readonly withinAdmissionLimit: boolean | null;
    readonly withinFinalLimit: boolean | null;
    readonly referenceInspection: DownloadIntegrityInspectionStatus;
    readonly validReferences: number | null;
    readonly invalidOrMissingReferences: number | null;
  };
}

interface Captured<T> {
  readonly status: DownloadIntegrityInspectionStatus;
  readonly value: T | null;
}

export interface DownloadIntegrityDependencies {
  readDbSnapshot(): Promise<DownloadIntegrityDbSnapshot>;
  scanAttachmentCache(shouldContinue?: () => boolean): Promise<AttachmentCacheScanFile[]>;
  inspectPartials(): Promise<BoundedDownloadPartialsInspection>;
  inspectWallpapers(): Promise<SyncedBackgroundCacheInspection>;
  validateWallpaper(path: string): Promise<boolean>;
  readAvailableBytes(): Promise<number>;
  readRuntime(): BoundedDownloadRuntimeDiagnostics;
  readCoordinator(): AttachmentCacheCoordinatorDiagnostics;
  readCandidate(): DownloadIntegrityCandidateIdentity;
}

function safeIdentity(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '—';
  const text = String(value);
  if (text.length < 1 || text.length > 80 || /[\u0000-\u001F\u007F]/.test(text)) return '—';
  return text;
}

const productionDependencies: DownloadIntegrityDependencies = {
  readDbSnapshot: () => readDownloadIntegrityDbSnapshot(getDatabase()),
  scanAttachmentCache: scanNativeAttachmentCacheFiles,
  inspectPartials: inspectNativeBoundedDownloadPartials,
  inspectWallpapers: inspectNativeSyncedBackgroundCache,
  validateWallpaper: validateNativeSyncedBackgroundCacheFile,
  readAvailableBytes: getNativeAttachmentCacheAvailableBytes,
  readRuntime: getBoundedDownloadRuntimeDiagnostics,
  readCoordinator: () => attachmentCacheCoordinator.diagnosticSnapshot(),
  readCandidate: () => ({
    appVersion: safeIdentity(Application.nativeApplicationVersion),
    appBuild: safeIdentity(Application.nativeBuildVersion),
    androidApi: safeIdentity(Platform.OS === 'android' ? Platform.Version : Platform.OS),
  }),
};

async function capture<T>(operation: () => Promise<T>): Promise<Captured<T>> {
  try {
    return { status: 'verified', value: await operation() };
  } catch {
    return { status: 'rejected', value: null };
  }
}

function safeSum(values: Iterable<number>): number | null {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - total) {
      return null;
    }
    total += value;
  }
  return total;
}

function snapshotsEqual(
  first: DownloadIntegrityDbSnapshot,
  second: DownloadIntegrityDbSnapshot,
): boolean {
  // Both private arrays are deterministically sorted by their repository queries. They never leave
  // this function; serialization is used only as an exact in-memory equality check.
  return JSON.stringify(first) === JSON.stringify(second);
}

function runtimeEqual(
  first: BoundedDownloadRuntimeDiagnostics,
  second: BoundedDownloadRuntimeDiagnostics,
): boolean {
  return (
    first.activeTransfers === second.activeTransfers &&
    first.activeDestinations === second.activeDestinations
  );
}

function coordinatorEqual(
  first: AttachmentCacheCoordinatorDiagnostics,
  second: AttachmentCacheCoordinatorDiagnostics,
): boolean {
  return (
    first.reservations === second.reservations &&
    first.reservedBytes === second.reservedBytes &&
    first.retirementOwners === second.retirementOwners &&
    first.pendingRetirements === second.pendingRetirements &&
    first.protectedPaths === second.protectedPaths &&
    first.protectionOwners === second.protectionOwners
  );
}

async function inspectWallpaperReferences(
  paths: readonly string[],
  shouldContinue: () => boolean,
  dependencies: DownloadIntegrityDependencies,
): Promise<{ readonly valid: number; readonly invalid: number }> {
  if (paths.length > MAX_VALIDATED_WALLPAPER_REFERENCES) {
    throw new Error('Wallpaper reference inspection is over its bound.');
  }
  let valid = 0;
  for (const path of paths) {
    if (!shouldContinue()) throw new Error('Account changed during inspection.');
    if (await dependencies.validateWallpaper(path)) valid += 1;
  }
  return { valid, invalid: paths.length - valid };
}

interface ReconciledCache {
  readonly nativeFiles: number;
  readonly nativeBytes: number;
  readonly activeMissing: number;
  readonly activeByteMismatches: number;
  readonly reservedPresent: number;
  readonly reservedMissing: number;
  readonly retiringPresent: number;
  readonly retiringMissing: number;
  readonly untrackedNative: number;
  readonly settledExact: boolean;
  readonly currentGenerationFiles: number;
  readonly foreignGenerationFiles: number;
  readonly unscopedGenerationFiles: number;
  readonly legacyLayoutFiles: number;
}

function reconcileAttachmentCache(
  snapshot: DownloadIntegrityDbSnapshot,
  nativeFiles: readonly AttachmentCacheScanFile[],
  currentGeneration: number,
): ReconciledCache | null {
  const nativeBytes = safeSum(nativeFiles.map((file) => file.bytes));
  if (nativeBytes === null) return null;
  const nativeByPath = new Map(nativeFiles.map((file) => [file.uri, file]));
  const ledgerByPath = new Map(snapshot.ledger.map((entry) => [entry.path, entry]));
  let activeMissing = 0;
  let activeByteMismatches = 0;
  let reservedPresent = 0;
  let reservedMissing = 0;
  let retiringPresent = 0;
  let retiringMissing = 0;

  for (const entry of snapshot.ledger) {
    const native = nativeByPath.get(entry.path);
    if (entry.state === 'active') {
      if (!native) activeMissing += 1;
      else if (native.bytes !== entry.bytes) activeByteMismatches += 1;
    } else if (entry.state === 'reserved') {
      if (native) reservedPresent += 1;
      else reservedMissing += 1;
    } else if (native) retiringPresent += 1;
    else retiringMissing += 1;
  }

  let untrackedNative = 0;
  let currentGenerationFiles = 0;
  let foreignGenerationFiles = 0;
  let unscopedGenerationFiles = 0;
  let legacyLayoutFiles = 0;
  for (const file of nativeFiles) {
    if (!ledgerByPath.has(file.uri)) untrackedNative += 1;
    const parsed = parseAttachmentCacheFileUri(file.uri);
    if (!parsed) legacyLayoutFiles += 1;
    else if (parsed.generation === UNSCOPED_MEDIA_GENERATION) unscopedGenerationFiles += 1;
    else if (parsed.generation === currentGeneration) currentGenerationFiles += 1;
    else foreignGenerationFiles += 1;
  }

  return {
    nativeFiles: nativeFiles.length,
    nativeBytes,
    activeMissing,
    activeByteMismatches,
    reservedPresent,
    reservedMissing,
    retiringPresent,
    retiringMissing,
    untrackedNative,
    settledExact:
      activeMissing === 0 &&
      activeByteMismatches === 0 &&
      snapshot.counts.cache.reservedFiles === 0 &&
      snapshot.counts.cache.retiringFiles === 0 &&
      untrackedNative === 0,
    currentGenerationFiles,
    foreignGenerationFiles,
    unscopedGenerationFiles,
    legacyLayoutFiles,
  };
}

export async function collectDownloadIntegrityDiagnostics(
  lease: RealtimeDeliveryLease,
  dependencies: DownloadIntegrityDependencies = productionDependencies,
): Promise<DownloadIntegrityReport | null> {
  let invalidated = !lease.isCurrent();
  const unsubscribe = subscribeRealtimeGenerationInvalidation(lease.generation, () => {
    invalidated = true;
  });
  const shouldContinue = (): boolean => !invalidated && lease.isCurrent();
  try {
    if (!shouldContinue()) return null;
    return await collectOwnedDownloadIntegrityDiagnostics(lease, shouldContinue, dependencies);
  } finally {
    unsubscribe();
  }
}

/**
 * Build a read-only, identifier-free report from two matching encrypted-DB snapshots.
 *
 * The public wrapper registers synchronous invalidation before its first await. Only the bounded
 * DB bookends enter the teardown barrier; read-only native inspection stays outside so Disconnect
 * cannot wait behind filesystem/image work. Private paths are used only for in-memory native
 * reconciliation. A generation change, DB write, runtime ownership change, or coordinator change
 * makes the whole attempt stale instead of publishing a mixed-account or mixed-time result. Native
 * failures become fixed `rejected` statuses; exception text is never returned to the screen.
 */
async function collectOwnedDownloadIntegrityDiagnostics(
  lease: RealtimeDeliveryLease,
  shouldContinue: () => boolean,
  dependencies: DownloadIntegrityDependencies,
): Promise<DownloadIntegrityReport | null> {
  const before = await readTrackedDbSnapshot(lease, dependencies);
  if (before === null || !shouldContinue()) return null;
  const runtimeBefore = dependencies.readRuntime();
  const coordinatorBefore = dependencies.readCoordinator();

  const [nativeCache, partials, nativeWallpapers, availableBytes, wallpaperReferences] =
    await Promise.all([
      capture(() => dependencies.scanAttachmentCache(shouldContinue)),
      capture(dependencies.inspectPartials),
      capture(dependencies.inspectWallpapers),
      capture(dependencies.readAvailableBytes),
      capture(() =>
        inspectWallpaperReferences(before.wallpaperPaths, shouldContinue, dependencies),
      ),
    ]);

  if (!shouldContinue()) return null;
  const runtimeAfter = dependencies.readRuntime();
  const coordinatorAfter = dependencies.readCoordinator();
  const after = await readTrackedDbSnapshot(lease, dependencies);
  if (after === null || !shouldContinue()) return null;
  if (
    !snapshotsEqual(before, after) ||
    !runtimeEqual(runtimeBefore, runtimeAfter) ||
    !coordinatorEqual(coordinatorBefore, coordinatorAfter)
  ) {
    throw new Error('Download integrity state changed during inspection.');
  }

  const ledgerFiles = before.ledger.length;
  const ledgerBytes = safeSum(before.ledger.map((entry) => entry.bytes));
  const reconciliation = nativeCache.value
    ? reconcileAttachmentCache(before, nativeCache.value, lease.generation)
    : null;
  const nativeInspection =
    nativeCache.status === 'verified' && reconciliation !== null ? 'verified' : 'rejected';
  const candidate = dependencies.readCandidate();

  return Object.freeze({
    candidate: Object.freeze({
      appVersion: safeIdentity(candidate.appVersion),
      appBuild: safeIdentity(candidate.appBuild),
      androidApi: safeIdentity(candidate.androidApi),
      migrationCount: before.counts.migrationCount,
      migrationHead: before.counts.migrationHead,
    }),
    databaseAndOwnershipMatched: true as const,
    downloads: Object.freeze({
      activeTransfers: runtimeBefore.activeTransfers,
      activeDestinations: runtimeBefore.activeDestinations,
      partialInspection: partials.status,
      partialFiles: partials.value?.files ?? null,
      partialBytes: partials.value?.bytes ?? null,
    }),
    receipts: before.counts.receipts,
    coordinator: coordinatorBefore,
    cache: Object.freeze({
      ledgerFiles,
      ledgerBytes,
      ...before.counts.cache,
      withinByteLimit: ledgerBytes !== null && ledgerBytes <= ATTACHMENT_CACHE_MAX_BYTES,
      withinFileLimit: ledgerFiles <= ATTACHMENT_CACHE_MAX_FILES,
      nativeInspection,
      nativeFiles: reconciliation?.nativeFiles ?? null,
      nativeBytes: reconciliation?.nativeBytes ?? null,
      activeMissing: reconciliation?.activeMissing ?? null,
      activeByteMismatches: reconciliation?.activeByteMismatches ?? null,
      reservedPresent: reconciliation?.reservedPresent ?? null,
      reservedMissing: reconciliation?.reservedMissing ?? null,
      retiringPresent: reconciliation?.retiringPresent ?? null,
      retiringMissing: reconciliation?.retiringMissing ?? null,
      untrackedNative: reconciliation?.untrackedNative ?? null,
      settledExact: reconciliation?.settledExact ?? null,
      currentGenerationFiles: reconciliation?.currentGenerationFiles ?? null,
      foreignGenerationFiles: reconciliation?.foreignGenerationFiles ?? null,
      unscopedGenerationFiles: reconciliation?.unscopedGenerationFiles ?? null,
      legacyLayoutFiles: reconciliation?.legacyLayoutFiles ?? null,
      freeSpaceInspection: availableBytes.status,
      availableBytes: availableBytes.value,
      freeSpaceFloorMet:
        availableBytes.value === null
          ? null
          : availableBytes.value >= ATTACHMENT_CACHE_MIN_FREE_BYTES,
    }),
    attachments: before.counts.attachments,
    wallpapers: Object.freeze({
      ...before.counts.wallpapers,
      nativeInspection: nativeWallpapers.status,
      nativeFiles: nativeWallpapers.value?.files ?? null,
      nativeBytes: nativeWallpapers.value?.bytes ?? null,
      withinAdmissionLimit: nativeWallpapers.value?.withinAdmissionLimit ?? null,
      withinFinalLimit: nativeWallpapers.value?.withinFinalLimit ?? null,
      referenceInspection: wallpaperReferences.status,
      validReferences: wallpaperReferences.value?.valid ?? null,
      invalidOrMissingReferences: wallpaperReferences.value?.invalid ?? null,
    }),
  });
}

async function readTrackedDbSnapshot(
  lease: RealtimeDeliveryLease,
  dependencies: DownloadIntegrityDependencies,
): Promise<DownloadIntegrityDbSnapshot | null> {
  let snapshot: DownloadIntegrityDbSnapshot | null = null;
  let completed = false;
  const status = await runTrackedRealtimeWork(lease, async (activeLease) => {
    if (!activeLease.isCurrent()) return;
    const next = await dependencies.readDbSnapshot();
    if (!activeLease.isCurrent()) return;
    snapshot = next;
    completed = true;
  });
  return status === 'delivered' && completed && lease.isCurrent() ? snapshot : null;
}
