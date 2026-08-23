import {
  adoptAttachmentCacheScanBatch,
  ATTACHMENT_CACHE_RECOVERY_BATCH_FILES,
  ATTACHMENT_CACHE_RECOVERY_MAX_FILES,
  listAttachmentCacheEntriesForRecovery,
  type AttachmentCacheScanAdoption,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  scanNativeAttachmentCacheFiles,
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

let readyGeneration: number | null = null;
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

/** New persistent downloads stay closed until this account generation completes startup repair. */
export function isAttachmentCacheRecoveryReady(lease: RealtimeDeliveryLease): boolean {
  return lease.isCurrent() && readyGeneration === lease.generation;
}

/** Explicit invalidation is useful at the start of a retry and for isolated tests. */
export function invalidateAttachmentCacheRecoveryReadiness(): void {
  readyGeneration = null;
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

  const physicalPaths = new Set<string>();
  const observations = manifest.map((file) => {
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
      physicalPaths.has(file.uri)
    ) {
      throw new RangeError(
        'Attachment cache recovery manifest is malformed or contains duplicates.',
      );
    }
    physicalPaths.add(file.uri);
    return {
      path: file.uri,
      bytes: file.bytes,
      // A future filesystem timestamp must not make an orphan permanently too recent to evict.
      lastUsedAt: Math.min(file.mtimeMs, now),
    };
  });

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
  return {
    status: 'ready',
    scannedFiles: manifest.length,
    adoptedFiles,
    deferredFiles,
    repairedMissingFiles,
    retiredFiles: crashDrain.confirmed + inactiveDrain.confirmed + conformance.confirmed,
    withinQuota: conformance.withinQuota,
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
      if (result.skipped > 0) {
        throw new Error('Attachment cache recovery found a protected crash owner.');
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
