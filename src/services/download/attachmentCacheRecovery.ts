import {
  adoptAttachmentCacheScanBatch,
  ATTACHMENT_CACHE_RECOVERY_BATCH_FILES,
  ATTACHMENT_CACHE_RECOVERY_MAX_FILES,
  getAttachmentCacheUsage,
  listAttachmentCacheEntriesForRecovery,
  type AttachmentCacheScanAdoption,
  type AttachmentCacheScanObservation,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  scanNativeAttachmentCacheFiles,
  scanNativeAttachmentCacheForRepair,
  type AttachmentCacheScanFile,
} from '@native/boundedDownload';
import { type RealtimeDeliveryLease } from '../realtime/deliveryCoordinator';
import { createAttachmentCacheAccountScope } from './attachmentCacheAccountScope';
import {
  attachmentCacheCoordinator,
  type AttachmentCacheCoordinator,
  type AttachmentCacheReservationScope,
} from './attachmentCacheCoordinator';

const MAX_RECOVERY_DRAIN_PASSES =
  Math.ceil(ATTACHMENT_CACHE_RECOVERY_MAX_FILES / ATTACHMENT_CACHE_RECOVERY_BATCH_FILES) + 2;
const MAX_RECOVERY_PATH_CHARS = 4096;
// A repair stops before one more page could push the ledger past startup recovery's limit.
const REPAIR_MAX_LEDGER_FILES =
  ATTACHMENT_CACHE_RECOVERY_MAX_FILES - ATTACHMENT_CACHE_RECOVERY_BATCH_FILES;

let readyGeneration: number | null = null;
let readyResult: AttachmentCacheRecoveryResult | null = null;
interface AttachmentCacheRecoveryFlight {
  readonly db: AppDatabase;
  readonly generation: number;
  readonly promise: Promise<AttachmentCacheRecoveryResult>;
}

const recoveryFlights: AttachmentCacheRecoveryFlight[] = [];
// Android exposes one native inventory cursor process-wide. Keep its complete recovery owner
// serialized across account generations so a quick Disconnect -> reconnect cannot receive BUSY
// from a stale generation's still-closing cursor and remain download-disabled until another boot.
let recoveryTail: Promise<void> = Promise.resolve();

export interface AttachmentCacheRecoveryResult {
  readonly status: 'ready' | 'stale';
  readonly scannedFiles: number;
  readonly adoptedFiles: number;
  readonly deferredFiles: number;
  readonly repairedMissingFiles: number;
  readonly retiredFiles: number;
  /** False means protected/recent or failed-cleanup rows still consume too much space. */
  readonly withinQuota: boolean;
}

export interface AttachmentCacheRecoveryDependencies {
  readonly scan?: () => Promise<AttachmentCacheScanFile[]>;
  readonly coordinator?: AttachmentCacheCoordinator;
  readonly now?: () => number;
}

export interface AttachmentCacheRepairProgress {
  /** Files read so far. */
  readonly checkedFiles: number;
  /** Files the ordinary cleanup has deleted so far. */
  readonly removedFiles: number;
}

export type AttachmentCacheRepairResult =
  | {
      readonly status: 'repaired';
      readonly checkedFiles: number;
      readonly removedFiles: number;
      /** False means files still in use keep the cache over its limits for now. */
      readonly withinQuota: boolean;
    }
  | {
      /** Cleanup could not free files fast enough: they are in use or the phone is low on space. */
      readonly status: 'blocked';
      readonly checkedFiles: number;
      readonly removedFiles: number;
    }
  | { readonly status: 'not-needed' | 'stale' };

export interface AttachmentCacheRepairDependencies extends AttachmentCacheRecoveryDependencies {
  readonly scanForRepair?: (
    onPage: (files: readonly AttachmentCacheScanFile[]) => Promise<void>,
    shouldContinue: () => boolean,
  ) => Promise<void>;
  readonly onProgress?: (progress: AttachmentCacheRepairProgress) => void;
}

/** Ends a repair's native scan early from inside a page; always mapped to a result. */
class AttachmentCacheRepairStop extends Error {
  readonly outcome: 'stale' | 'blocked';

  constructor(outcome: 'stale' | 'blocked') {
    super(`Attachment cache repair stopped: ${outcome}`);
    this.name = 'AttachmentCacheRepairStop';
    this.outcome = outcome;
  }
}

/** New persistent downloads stay closed until this account generation completes startup repair. */
export function isAttachmentCacheRecoveryReady(lease: RealtimeDeliveryLease): boolean {
  return lease.isCurrent() && readyGeneration === lease.generation;
}

/** Explicit invalidation is useful at the start of a retry and for isolated tests. */
export function invalidateAttachmentCacheRecoveryReadiness(): void {
  readyGeneration = null;
  readyResult = null;
}

/**
 * Reconcile one complete native manifest with the encrypted path ledger before sync/realtime start.
 *
 * No DB or filesystem mutation occurs until `scan()` has returned the entire bounded manifest.
 * Reconciliation then uses short, account-guarded transactions and the ordinary exact-delete
 * coordinator. The operation is idempotent: a crash between batches leaves every completed batch
 * durably accounted, while readiness remains closed until a later run finishes.
 */
export function recoverAttachmentCache(
  db: AppDatabase,
  lease: RealtimeDeliveryLease,
  dependencies: AttachmentCacheRecoveryDependencies = {},
): Promise<AttachmentCacheRecoveryResult> {
  if (!lease.isCurrent()) return Promise.resolve(staleResult());
  // Every cache operation after a completed recovery keeps the ledger in step, so a second
  // activation of the same account generation in this process (a killed-app push wake, then
  // opening the app) has nothing to repair. Re-running would only close readiness meanwhile.
  if (isAttachmentCacheRecoveryReady(lease) && readyResult) return Promise.resolve(readyResult);
  const existing = recoveryFlights.find(
    (flight) => flight.db === db && flight.generation === lease.generation,
  );
  if (existing) {
    return existing.promise;
  }
  readyGeneration = null;
  const previous = recoveryTail;
  const promise = previous.then(() =>
    lease.isCurrent() ? performAttachmentCacheRecovery(db, lease, dependencies) : staleResult(),
  );
  const owner = { db, generation: lease.generation, promise };
  recoveryFlights.push(owner);
  // A failed recovery must release the queue for the next authorized account without creating an
  // unhandled rejection. The caller still receives the original rejecting promise above.
  recoveryTail = promise.then(
    () => undefined,
    () => undefined,
  );
  const clear = (): void => {
    const index = recoveryFlights.indexOf(owner);
    if (index >= 0) recoveryFlights.splice(index, 1);
  };
  void promise.then(clear, clear);
  return promise;
}

async function performAttachmentCacheRecovery(
  db: AppDatabase,
  lease: RealtimeDeliveryLease,
  dependencies: AttachmentCacheRecoveryDependencies,
): Promise<AttachmentCacheRecoveryResult> {
  if (!lease.isCurrent()) return staleResult();
  const scan = dependencies.scan ?? scanNativeAttachmentCacheFiles;
  const coordinator = dependencies.coordinator ?? attachmentCacheCoordinator;
  const now = (dependencies.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError('Attachment cache recovery time must be a non-negative safe integer.');
  }

  // This await is intentionally before the first DB transaction or coordinator deletion.
  const manifest = await scan();
  if (!lease.isCurrent()) return staleResult(manifest.length);
  if (manifest.length > ATTACHMENT_CACHE_RECOVERY_MAX_FILES) {
    throw new RangeError('Attachment cache recovery manifest exceeds its hard file limit.');
  }

  const observations = scanObservations(manifest, now);
  const physicalPaths = new Set(observations.map((observation) => observation.path));

  // Validation of the ENTIRE manifest above is deliberately before this first mutation-capable
  // scope. A duplicate or malformed last page can therefore never leave an adopted first page.
  const scope = createAttachmentCacheAccountScope(lease);
  let adoptedFiles = 0;
  let deferredFiles = 0;
  for (
    let offset = 0;
    offset < observations.length;
    offset += ATTACHMENT_CACHE_RECOVERY_BATCH_FILES
  ) {
    const page = observations.slice(offset, offset + ATTACHMENT_CACHE_RECOVERY_BATCH_FILES);
    let adoption: AttachmentCacheScanAdoption | null;
    try {
      adoption = await scope.runTracked(() =>
        withDbTransaction(
          db,
          (context) => adoptAttachmentCacheScanBatch(context, page, now),
          () => scope.isCurrent(),
        ),
      );
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError) return staleResult(manifest.length);
      throw error;
    }
    if (adoption === null) return staleResult(manifest.length);
    adoptedFiles += adoption.activePaths.length;
    deferredFiles += adoption.retiringPaths.length + adoption.deferredPaths.length;
  }

  let entries;
  try {
    entries = await scope.runTracked(() =>
      withDbTransaction(
        db,
        async () => listAttachmentCacheEntriesForRecovery(db),
        () => scope.isCurrent(),
      ),
    );
  } catch (error) {
    if (error instanceof DbCommitGuardRejectedError) return staleResult(manifest.length);
    throw error;
  }
  if (entries === null) return staleResult(manifest.length);
  if (entries.length > ATTACHMENT_CACHE_RECOVERY_MAX_FILES) {
    throw new RangeError('Attachment cache ledger exceeds its hard file limit.');
  }

  let repairedMissingFiles = 0;
  for (const entry of entries) {
    if (entry.state !== 'active' || physicalPaths.has(entry.path)) continue;
    const reuse = await coordinator.reuseExisting(db, { path: entry.path, scope });
    if (reuse.status === 'stale') return staleResult(manifest.length);
    if (reuse.status === 'missing') repairedMissingFiles += 1;
    else if (reuse.status !== 'hit') {
      throw new Error(
        `Attachment cache recovery could not revalidate an active path: ${reuse.status}`,
      );
    }
  }

  const crashDrain = await drainCrashOwners(db, coordinator, scope);
  if (crashDrain.status === 'stale') {
    return staleResult(manifest.length);
  }
  const inactiveDrain = await retireInactiveFiles(db, coordinator, scope);
  if (inactiveDrain.status === 'stale') {
    return staleResult(manifest.length);
  }
  const conformance = await coordinator.conformCurrentQuota(db, { scope });
  if (conformance.status === 'stale') return staleResult(manifest.length);
  if (!lease.isCurrent()) return staleResult(manifest.length);

  readyGeneration = lease.generation;
  readyResult = {
    status: 'ready',
    scannedFiles: manifest.length,
    adoptedFiles,
    deferredFiles,
    repairedMissingFiles,
    retiredFiles: crashDrain.confirmed + inactiveDrain.confirmed + conformance.confirmed,
    withinQuota: conformance.withinQuota,
  };
  return readyResult;
}

/**
 * Storage → Repair Downloads (review item 888): bring an oversized old cache back within the
 * limits startup recovery needs, then run that recovery so downloads turn back on.
 *
 * Startup recovery reads a complete manifest of at most 8,192 files before changing anything, so a
 * larger old cache failed the same way on every launch. The repair reads the cache in pages with no
 * total. Each page is accounted in the ledger exactly like a startup page, then the ordinary
 * cleanup runs: it deletes files nothing references and the least recently used files beyond the
 * normal 2 GiB / 4,096-file limits, keeps every protection (on screen, in use, outgoing sends,
 * pending Photos copies, recent use), and clears each deleted file's attachment path so its message
 * offers the download again. If cleanup cannot keep the ledger below startup's limit, the repair
 * stops as `blocked` instead of growing it. Serialized with recovery.
 */
export function repairAttachmentCache(
  db: AppDatabase,
  lease: RealtimeDeliveryLease,
  dependencies: AttachmentCacheRepairDependencies = {},
): Promise<AttachmentCacheRepairResult> {
  if (!lease.isCurrent()) return Promise.resolve({ status: 'stale' });
  const promise = recoveryTail.then(() => performAttachmentCacheRepair(db, lease, dependencies));
  recoveryTail = promise.then(
    () => undefined,
    () => undefined,
  );
  return promise;
}

async function performAttachmentCacheRepair(
  db: AppDatabase,
  lease: RealtimeDeliveryLease,
  dependencies: AttachmentCacheRepairDependencies,
): Promise<AttachmentCacheRepairResult> {
  if (!lease.isCurrent()) return { status: 'stale' };
  if (isAttachmentCacheRecoveryReady(lease)) return { status: 'not-needed' };
  const scan = dependencies.scanForRepair ?? scanNativeAttachmentCacheForRepair;
  const coordinator = dependencies.coordinator ?? attachmentCacheCoordinator;
  const now = (dependencies.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError('Attachment cache repair time must be a non-negative safe integer.');
  }

  const scope = createAttachmentCacheAccountScope(lease);
  let checkedFiles = 0;
  let removedFiles = 0;
  try {
    await scan(
      async (files) => {
        const observations = scanObservations(files, now);
        const adoption = await scope.runTracked(() =>
          withDbTransaction(
            db,
            (context) => adoptAttachmentCacheScanBatch(context, observations, now),
            () => scope.isCurrent(),
          ),
        );
        if (adoption === null) throw new AttachmentCacheRepairStop('stale');
        checkedFiles += files.length;

        const inactive = await retireInactiveFiles(db, coordinator, scope);
        if (inactive.status === 'stale') throw new AttachmentCacheRepairStop('stale');
        const conformance = await coordinator.conformCurrentQuota(db, { scope });
        if (conformance.status === 'stale') throw new AttachmentCacheRepairStop('stale');
        removedFiles += inactive.confirmed + conformance.confirmed;
        dependencies.onProgress?.({ checkedFiles, removedFiles });

        if (!conformance.withinQuota) {
          const usage = await scope.runTracked(() =>
            withDbTransaction(
              db,
              async () => getAttachmentCacheUsage(db),
              () => scope.isCurrent(),
            ),
          );
          if (usage === null) throw new AttachmentCacheRepairStop('stale');
          if (usage.files > REPAIR_MAX_LEDGER_FILES) {
            throw new AttachmentCacheRepairStop('blocked');
          }
        }
      },
      () => lease.isCurrent(),
    );
  } catch (error) {
    if (error instanceof AttachmentCacheRepairStop && error.outcome === 'blocked') {
      return { status: 'blocked', checkedFiles, removedFiles };
    }
    if (
      error instanceof AttachmentCacheRepairStop ||
      error instanceof DbCommitGuardRejectedError ||
      !lease.isCurrent()
    ) {
      return { status: 'stale' };
    }
    throw error;
  }

  // The cache now fits, so the ordinary recovery can finish and reopen downloads.
  const recovery = await performAttachmentCacheRecovery(db, lease, dependencies);
  if (recovery.status === 'stale') return { status: 'stale' };
  return {
    status: 'repaired',
    checkedFiles,
    removedFiles: removedFiles + recovery.retiredFiles,
    withinQuota: recovery.withinQuota,
  };
}

async function drainCrashOwners(
  db: AppDatabase,
  coordinator: AttachmentCacheCoordinator,
  scope: AttachmentCacheReservationScope,
): Promise<RecoveryDrainOutcome> {
  let confirmed = 0;
  for (let pass = 0; pass < MAX_RECOVERY_DRAIN_PASSES; pass += 1) {
    const result = await coordinator.drainDueRetirements(db, {
      scope,
      limit: ATTACHMENT_CACHE_RECOVERY_BATCH_FILES,
    });
    if (result.status === 'stale') return { status: 'stale', confirmed };
    confirmed += result.confirmed;
    if (result.attempted === 0) {
      // Every due row left was skipped: this process still owns it (a live download, cleanup, or
      // pinned reader) or it changed after the listing. Neither is a crash leftover; its owner
      // settles it. New reservations are due immediately, so treating them as crashes disabled
      // downloads for the session. Only a full batch of skips could hide a leftover behind it.
      if (result.skipped >= ATTACHMENT_CACHE_RECOVERY_BATCH_FILES) {
        throw new Error('Attachment cache recovery found a full batch of rows still in use.');
      }
      return { status: 'complete', confirmed };
    }
  }
  throw new Error('Attachment cache crash-owner recovery exceeded its bounded pass limit.');
}

async function retireInactiveFiles(
  db: AppDatabase,
  coordinator: AttachmentCacheCoordinator,
  scope: AttachmentCacheReservationScope,
): Promise<RecoveryDrainOutcome> {
  let confirmed = 0;
  for (let pass = 0; pass < MAX_RECOVERY_DRAIN_PASSES; pass += 1) {
    const result = await coordinator.retireInactiveEntries(db, {
      scope,
      limit: ATTACHMENT_CACHE_RECOVERY_BATCH_FILES,
    });
    if (result.status === 'stale') return { status: 'stale', confirmed };
    confirmed += result.confirmed;
    if (result.attempted === 0) return { status: 'complete', confirmed };
  }
  throw new Error('Attachment cache inactive-file recovery exceeded its bounded pass limit.');
}

interface RecoveryDrainOutcome {
  readonly status: 'complete' | 'stale';
  readonly confirmed: number;
}

/** Validate a startup manifest or one repair page before any mutation. */
function scanObservations(
  files: readonly AttachmentCacheScanFile[],
  now: number,
): AttachmentCacheScanObservation[] {
  const paths = new Set<string>();
  return files.map((file) => {
    if (
      file == null ||
      typeof file !== 'object' ||
      typeof file.uri !== 'string' ||
      file.uri.length === 0 ||
      file.uri.length > MAX_RECOVERY_PATH_CHARS ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !Number.isSafeInteger(file.mtimeMs) ||
      file.mtimeMs < 0 ||
      paths.has(file.uri)
    ) {
      throw new RangeError(
        'Attachment cache recovery manifest is malformed or contains duplicates.',
      );
    }
    paths.add(file.uri);
    return {
      path: file.uri,
      bytes: file.bytes,
      // A future filesystem timestamp must not make an orphan permanently too recent to evict.
      lastUsedAt: Math.min(file.mtimeMs, now),
    };
  });
}

function staleResult(scannedFiles = 0): AttachmentCacheRecoveryResult {
  return {
    status: 'stale',
    scannedFiles,
    adoptedFiles: 0,
    deferredFiles: 0,
    repairedMissingFiles: 0,
    retiredFiles: 0,
    withinQuota: false,
  };
}
