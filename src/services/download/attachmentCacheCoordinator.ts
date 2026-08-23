import {
  claimAttachmentCachePathsForRetirement,
  confirmAttachmentCacheEntryDeleted,
  createAttachmentCacheReservation,
  getAttachmentCacheEntry,
  getAttachmentCacheQuotaSnapshot,
  listInactiveAttachmentCachePaths,
  listDueAttachmentCacheRetirements,
  recordAttachmentCacheAccess,
  repairMissingActiveAttachmentCacheEntry,
  scheduleAttachmentCacheRetirementRetry,
  type AttachmentCacheEntry,
  type AttachmentCacheQuotaSnapshot,
  type AttachmentCacheRetirementClaim,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  deleteNativeAttachmentCacheFile,
  getNativeAttachmentCacheAvailableBytes,
  statNativeAttachmentCacheFile,
  type AttachmentCacheDeleteResult,
  type AttachmentCacheFileStat,
} from '@native/boundedDownload';
import {
  ATTACHMENT_CACHE_MAX_FILES,
  planAttachmentCacheAdmission,
  planAttachmentCacheConformance,
} from './attachmentCacheQuotaPolicy';

const MAX_RETIREMENT_CLAIM_PATHS = 100;
const MAX_ADMISSION_REPLANS = 64;
const MAX_PROTECTED_PATHS = 8192;
const MAX_PATH_CHARS = 4096;
export const ATTACHMENT_CACHE_ACCESS_TOUCH_INTERVAL_MS = 60 * 1000;

export interface AttachmentCacheNativeBoundary {
  getAvailableBytes(): Promise<number>;
  statFile(path: string): Promise<AttachmentCacheFileStat>;
  deleteFile(path: string): Promise<AttachmentCacheDeleteResult>;
}

/**
 * Account scope used while creating or revalidating durable cache ownership.
 *
 * `runTracked` owns only the account-teardown drain lifetime. It must not open a DB transaction:
 * the coordinator opens each explicit transaction at the mutation site below.
 */
export interface AttachmentCacheReservationScope {
  readonly generation: number;
  isCurrent(): boolean;
  runTracked<T>(task: () => Promise<T>): Promise<T | null>;
}

export interface AttachmentCacheReservation {
  readonly path: string;
  readonly maxBytes: number;
  readonly generation: number | 'unscoped';
  /**
   * Open the reservation→mounted-consumer handoff after its durable row was promoted to active.
   * Synchronous and identity-checked because the caller holds the DB transaction lock here.
   */
  beginProtectionHandoff(): boolean;
  /** Close a handoff whose surrounding DB transaction will roll back; existing pins stay valid. */
  rollbackProtectionHandoff(): boolean;
  /** Idempotent and identity-checked: an old release can never remove a newer path owner. */
  release(): Promise<void>;
}

export interface AttachmentCachePathProtection {
  readonly path: string;
  /** Synchronous so a UI/send handoff can pin the path before its first await. */
  release(): void;
}

export type AttachmentCacheAdmission =
  | { readonly status: 'reserved'; readonly reservation: AttachmentCacheReservation }
  | { readonly status: 'busy' | 'stale' | 'storage' };

export type AttachmentCacheReuseResult =
  { readonly status: 'hit' | 'missing' } | { readonly status: 'busy' | 'stale' | 'unavailable' };

export interface AttachmentCacheRetirementDrainResult {
  readonly status: 'complete' | 'stale';
  readonly attempted: number;
  readonly confirmed: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface AttachmentCacheQuotaConformanceResult extends AttachmentCacheRetirementDrainResult {
  /** True only after a fresh native-free-space + complete-ledger snapshot satisfies every cap. */
  readonly withinQuota: boolean;
}

interface ReservationRecord {
  readonly token: symbol;
  readonly path: string;
  readonly maxBytes: number;
  readonly generation: number | 'unscoped';
  acceptsProtections: boolean;
}

interface RetirementRecord {
  readonly token: symbol;
  readonly path: string;
}

type AdmissionStep =
  | { readonly status: 'reserved'; readonly reservation: AttachmentCacheReservation }
  | { readonly status: 'busy' | 'stale' | 'storage' | 'replan' }
  | { readonly status: 'retire'; readonly records: readonly RetirementRecord[] };

type ConformanceStep =
  | { readonly status: 'within_quota' }
  | { readonly status: 'blocked' }
  | { readonly status: 'stale' }
  | { readonly status: 'replan'; readonly skipped: number }
  | { readonly status: 'retire'; readonly records: readonly RetirementRecord[] };

const nativeBoundary: AttachmentCacheNativeBoundary = {
  getAvailableBytes: getNativeAttachmentCacheAvailableBytes,
  statFile: statNativeAttachmentCacheFile,
  deleteFile: deleteNativeAttachmentCacheFile,
};

function requirePath(path: string): void {
  if (path.length === 0 || path.length > MAX_PATH_CHARS) {
    throw new RangeError(`Attachment cache path must contain 1-${MAX_PATH_CHARS} characters.`);
  }
}

function requirePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
}

/**
 * Stateful admission/retirement coordinator for ordinary persistent attachment downloads.
 *
 * Lock order is always this coordinator's gate, then the shared DB transaction lock. Native file
 * deletion happens after both are released. That keeps database callbacks short and avoids the
 * nested-transaction deadlock documented in AGENTS.md.
 */
export class AttachmentCacheCoordinator {
  private gate: Promise<void> = Promise.resolve();
  private readonly reservations = new Map<string, ReservationRecord>();
  private readonly retirementOwners = new Map<string, RetirementRecord>();
  private readonly pendingRetirements = new Set<string>();
  private readonly protections = new Map<string, Set<symbol>>();

  constructor(
    private readonly io: AttachmentCacheNativeBoundary = nativeBoundary,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Reserve one exact final path before directory creation or native streaming begins.
   *
   * A plan that needs eviction first claims a bounded LRU batch, deletes it outside the locks, and
   * re-reads native free space plus the ledger before admitting. Predicted deletion is never enough.
   */
  async reserve(
    db: AppDatabase,
    input: {
      readonly path: string;
      readonly maxBytes: number;
      readonly scope?: AttachmentCacheReservationScope;
    },
  ): Promise<AttachmentCacheAdmission> {
    requirePath(input.path);
    requirePositiveSafeInteger(input.maxBytes, 'Attachment cache reservation bytes');
    const deniedPaths = new Set<string>();

    // Recover crash-surviving work before planning. Retiring bytes stay charged, so merely seeing
    // them in the snapshot could reject an otherwise safe download forever without this pass.
    const recovery = await this.drainDueRetirements(db, {
      scope: input.scope,
      limit: MAX_RETIREMENT_CLAIM_PATHS,
    });
    if (recovery.status === 'stale') return { status: 'stale' };

    for (let attempt = 0; attempt < MAX_ADMISSION_REPLANS; attempt += 1) {
      const step = await this.runExclusive(() =>
        this.planAdmissionStep(db, input.path, input.maxBytes, input.scope, deniedPaths),
      );
      if (step.status === 'reserved') return step;
      if (step.status === 'busy' || step.status === 'stale' || step.status === 'storage') {
        return { status: step.status };
      }
      if (step.status === 'replan') continue;
      if (step.status === 'retire') {
        for (const record of step.records) {
          await this.settleRetirement(db, record, input.scope);
        }
      }
    }

    // A repeatedly changing ledger/protection set is not a reason to bypass the cap.
    return { status: 'storage' };
  }

  /**
   * Bring the cache that exists now back under the byte, file, and native free-space limits.
   *
   * Every pass takes a fresh authoritative snapshot while holding the coordinator gate. A
   * successful DB claim merely grants exact-path delete ownership; native deletion and durable
   * confirmation happen outside both locks, then the next pass proves whether the cache conforms.
   */
  async conformCurrentQuota(
    db: AppDatabase,
    input: { readonly scope?: AttachmentCacheReservationScope } = {},
  ): Promise<AttachmentCacheQuotaConformanceResult> {
    const recovery = await this.drainDueRetirements(db, {
      scope: input.scope,
      limit: MAX_RETIREMENT_CLAIM_PATHS,
    });
    let attempted = recovery.attempted;
    let confirmed = recovery.confirmed;
    let failed = recovery.failed;
    let skipped = recovery.skipped;
    if (recovery.status === 'stale') {
      return { status: 'stale', withinQuota: false, attempted, confirmed, failed, skipped };
    }

    const deniedPaths = new Set<string>();
    for (let attempt = 0; attempt < MAX_ADMISSION_REPLANS; attempt += 1) {
      const step = await this.runExclusive(() =>
        this.planConformanceStep(db, input.scope, deniedPaths),
      );
      if (step.status === 'within_quota') {
        return { status: 'complete', withinQuota: true, attempted, confirmed, failed, skipped };
      }
      if (step.status === 'stale') {
        return { status: 'stale', withinQuota: false, attempted, confirmed, failed, skipped };
      }
      if (step.status === 'blocked') {
        return { status: 'complete', withinQuota: false, attempted, confirmed, failed, skipped };
      }
      if (step.status === 'replan') {
        skipped += step.skipped;
        continue;
      }

      for (const record of step.records) {
        attempted += 1;
        const outcome = await this.settleRetirement(db, record, input.scope);
        if (outcome === 'stale') {
          return { status: 'stale', withinQuota: false, attempted, confirmed, failed, skipped };
        }
        if (outcome === 'confirmed') confirmed += 1;
        else failed += 1;
      }
    }

    // The cap is fail-closed: unsafe or repeatedly changing overage stays charged in the ledger,
    // so later admissions continue to reject until an authorized pass can prove conformance.
    return { status: 'complete', withinQuota: false, attempted, confirmed, failed, skipped };
  }

  /**
   * Pin a cache path synchronously while UI/native presentation or an outgoing handoff needs it.
   * Returns null when retirement already owns the path; the caller must fail/reload instead.
   */
  protect(path: string): AttachmentCachePathProtection | null {
    requirePath(path);
    const reservation = this.reservations.get(path);
    if (
      (reservation !== undefined && !reservation.acceptsProtections) ||
      this.pendingRetirements.has(path) ||
      this.retirementOwners.has(path)
    )
      return null;
    if (!this.protections.has(path) && this.protections.size >= MAX_PROTECTED_PATHS) return null;

    const token = Symbol(path);
    const owners = this.protections.get(path) ?? new Set<symbol>();
    owners.add(token);
    this.protections.set(path, owners);
    let released = false;
    return {
      path,
      release: () => {
        if (released) return;
        released = true;
        const current = this.protections.get(path);
        current?.delete(token);
        if (current?.size === 0) this.protections.delete(path);
      },
    };
  }

  /**
   * Revalidate one persisted local path before it is reused.
   *
   * Protection is acquired synchronously and held across the exact native stat plus the ledger
   * transaction. Present files are reusable only with an active ledger row. A missing active file
   * is repaired atomically so every stale reference is cleared before a replacement download can
   * reserve the path. Untracked-present and reserved/retiring paths fail closed for startup
   * recovery instead of being adopted here.
   */
  reuseExisting(
    db: AppDatabase,
    input: {
      readonly path: string;
      readonly scope?: AttachmentCacheReservationScope;
    },
  ): Promise<AttachmentCacheReuseResult> {
    requirePath(input.path);
    const protection = this.protect(input.path);
    if (!protection) return Promise.resolve({ status: 'busy' });
    return this.reuseProtected(db, input.path, input.scope).finally(protection.release);
  }

  /**
   * Retire active ledger files that no live message references.
   *
   * Tombstone/chat writers deliberately leave this to the coordinator: only this process-wide
   * owner can see mounted-viewer and forward/send handoff pins. A crash before this best-effort
   * pass leaves an active, still-accounted file; the next authorized startup repeats the scan.
   */
  async retireInactiveEntries(
    db: AppDatabase,
    input: { readonly scope?: AttachmentCacheReservationScope; readonly limit?: number } = {},
  ): Promise<AttachmentCacheRetirementDrainResult> {
    let skipped = 0;
    const step = await this.runExclusive(async () => {
      const pending: string[] = [];
      try {
        const scope = input.scope;
        let claimResult: {
          readonly claim: AttachmentCacheRetirementClaim;
          readonly skippedBeforeClaim: number;
          readonly requestedPaths: number;
        } | null;
        try {
          if (scope) {
            // Account-scoped chat/send cleanup and startup recovery expose their exact transaction
            // owner at the write site. Unscoped standalone work retains the direct owner below.
            claimResult = await scope.runTracked(() =>
              withDbTransaction(
                db,
                async (context) => {
                  const candidates = await listInactiveAttachmentCachePaths(db, input.limit);
                  const eligible = candidates.filter((path) => {
                    const blocked =
                      this.reservations.has(path) ||
                      this.retirementOwners.has(path) ||
                      this.pendingRetirements.has(path) ||
                      this.protections.has(path);
                    if (blocked) skipped += 1;
                    return !blocked;
                  });
                  eligible.forEach((path) => {
                    this.pendingRetirements.add(path);
                    pending.push(path);
                  });
                  if (eligible.length === 0) return null;
                  const firstClaim = await claimAttachmentCachePathsForRetirement(
                    context,
                    eligible,
                  );
                  if (
                    firstClaim.status !== 'refused' ||
                    firstClaim.reason !== 'outgoing_protected'
                  ) {
                    return {
                      claim: firstClaim,
                      skippedBeforeClaim: 0,
                      requestedPaths: eligible.length,
                    };
                  }

                  // The outgoing refusal is a read-only preflight. Keep the SAME outer transaction
                  // and pending ownership, remove only exact protected paths, and retry at most once.
                  const refused = new Set(firstClaim.paths);
                  const retryPaths = eligible.filter((path) => !refused.has(path));
                  if (retryPaths.length === 0) {
                    return {
                      claim: firstClaim,
                      skippedBeforeClaim: 0,
                      requestedPaths: eligible.length,
                    };
                  }
                  return {
                    claim: await claimAttachmentCachePathsForRetirement(context, retryPaths),
                    skippedBeforeClaim: firstClaim.paths.length,
                    requestedPaths: retryPaths.length,
                  };
                },
                () => scope.isCurrent(),
              ),
            );
          } else {
            claimResult = await withDbTransaction(db, async (context) => {
              const candidates = await listInactiveAttachmentCachePaths(db, input.limit);
              const eligible = candidates.filter((path) => {
                const blocked =
                  this.reservations.has(path) ||
                  this.retirementOwners.has(path) ||
                  this.pendingRetirements.has(path) ||
                  this.protections.has(path);
                if (blocked) skipped += 1;
                return !blocked;
              });
              eligible.forEach((path) => {
                this.pendingRetirements.add(path);
                pending.push(path);
              });
              if (eligible.length === 0) return null;
              const firstClaim = await claimAttachmentCachePathsForRetirement(context, eligible);
              if (firstClaim.status !== 'refused' || firstClaim.reason !== 'outgoing_protected') {
                return {
                  claim: firstClaim,
                  skippedBeforeClaim: 0,
                  requestedPaths: eligible.length,
                };
              }

              // The unscoped owner keeps the same bounded first-claim plus safe-sibling retry.
              const refused = new Set(firstClaim.paths);
              const retryPaths = eligible.filter((path) => !refused.has(path));
              if (retryPaths.length === 0) {
                return {
                  claim: firstClaim,
                  skippedBeforeClaim: 0,
                  requestedPaths: eligible.length,
                };
              }
              return {
                claim: await claimAttachmentCachePathsForRetirement(context, retryPaths),
                skippedBeforeClaim: firstClaim.paths.length,
                requestedPaths: retryPaths.length,
              };
            });
          }
        } catch (error) {
          if (error instanceof DbCommitGuardRejectedError && scope) claimResult = null;
          else throw error;
        }
        if (claimResult === null) {
          return scope && !scope.isCurrent()
            ? ({ status: 'stale' } as const)
            : ({ status: 'empty' } as const);
        }
        skipped += claimResult.skippedBeforeClaim;
        if (claimResult.claim.status === 'refused') {
          skipped += claimResult.requestedPaths;
          return { status: 'empty' } as const;
        }
        const records = claimResult.claim.paths.map((path) => {
          const record = { token: Symbol(path), path };
          this.retirementOwners.set(path, record);
          return record;
        });
        return { status: 'claimed', records } as const;
      } finally {
        pending.forEach((path) => this.pendingRetirements.delete(path));
      }
    });

    if (step.status === 'stale') {
      return { status: 'stale', attempted: 0, confirmed: 0, failed: 0, skipped };
    }
    if (step.status === 'empty') {
      return { status: 'complete', attempted: 0, confirmed: 0, failed: 0, skipped };
    }

    let confirmed = 0;
    let failed = 0;
    for (const record of step.records) {
      const outcome = await this.settleRetirement(db, record, input.scope);
      if (outcome === 'stale') {
        return {
          status: 'stale',
          attempted: confirmed + failed + 1,
          confirmed,
          failed,
          skipped,
        };
      }
      if (outcome === 'confirmed') confirmed += 1;
      else failed += 1;
    }
    return {
      status: 'complete',
      attempted: step.records.length,
      confirmed,
      failed,
      skipped,
    };
  }

  /** Retry a bounded set of crash-surviving `retiring` rows after session authorization. */
  async drainDueRetirements(
    db: AppDatabase,
    input: { readonly scope?: AttachmentCacheReservationScope; readonly limit?: number } = {},
  ): Promise<AttachmentCacheRetirementDrainResult> {
    const scope = input.scope;
    let entries: AttachmentCacheEntry[] | null;
    try {
      if (scope) {
        // Account-scoped cleanup exposes the exact due-list transaction owner at this read site.
        // Unscoped standalone cleanup retains the direct owner below.
        entries = await scope.runTracked(() =>
          withDbTransaction(
            db,
            () => listDueAttachmentCacheRetirements(db, this.now(), input.limit),
            () => scope.isCurrent(),
          ),
        );
      } else {
        entries = await withDbTransaction(db, () =>
          listDueAttachmentCacheRetirements(db, this.now(), input.limit),
        );
      }
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError && scope) entries = null;
      else throw error;
    }
    if (entries === null) {
      return { status: 'stale', attempted: 0, confirmed: 0, failed: 0, skipped: 0 };
    }

    let attempted = 0;
    let confirmed = 0;
    let failed = 0;
    let skipped = 0;
    for (const entry of entries) {
      const ownership = await this.runExclusive(async () => {
        if (
          this.reservations.has(entry.path) ||
          this.retirementOwners.has(entry.path) ||
          this.pendingRetirements.has(entry.path) ||
          this.protections.has(entry.path)
        ) {
          return { status: 'skipped' } as const;
        }
        // `entries` came from a transaction that ended before this gate slot. A staged reservation
        // may have promoted to active in that gap. Re-read under gate before granting native delete
        // ownership; stale recovery must never unlink a newly committed file.
        let current: { readonly entry: AttachmentCacheEntry | null } | null;
        try {
          if (scope) {
            current = await scope.runTracked(() =>
              withDbTransaction(
                db,
                async () => ({ entry: await getAttachmentCacheEntry(db, entry.path) }),
                () => scope.isCurrent(),
              ),
            );
          } else {
            current = await withDbTransaction(db, async () => ({
              entry: await getAttachmentCacheEntry(db, entry.path),
            }));
          }
        } catch (error) {
          if (error instanceof DbCommitGuardRejectedError && scope) current = null;
          else throw error;
        }
        if (current === null) return { status: 'stale' } as const;
        if (
          current.entry === null ||
          (current.entry.state !== 'reserved' && current.entry.state !== 'retiring')
        ) {
          return { status: 'skipped' } as const;
        }
        const owned = { token: Symbol(entry.path), path: entry.path };
        this.retirementOwners.set(entry.path, owned);
        return { status: 'owned', record: owned } as const;
      });
      if (ownership.status === 'stale') {
        return { status: 'stale', attempted, confirmed, failed, skipped };
      }
      if (ownership.status === 'skipped') {
        skipped += 1;
        continue;
      }
      attempted += 1;
      const outcome = await this.settleRetirement(db, ownership.record, input.scope);
      if (outcome === 'stale') {
        return { status: 'stale', attempted, confirmed, failed, skipped };
      }
      if (outcome === 'confirmed') confirmed += 1;
      else failed += 1;
    }
    return { status: 'complete', attempted, confirmed, failed, skipped };
  }

  private async planAdmissionStep(
    db: AppDatabase,
    path: string,
    maxBytes: number,
    scope: AttachmentCacheReservationScope | undefined,
    deniedPaths: Set<string>,
  ): Promise<AdmissionStep> {
    if (scope && !scope.isCurrent()) return { status: 'stale' };
    if (
      this.reservations.has(path) ||
      this.retirementOwners.has(path) ||
      this.pendingRetirements.has(path)
    ) {
      return { status: 'busy' };
    }

    let availableBytes: number;
    try {
      availableBytes = await this.io.getAvailableBytes();
    } catch {
      return { status: scope && !scope.isCurrent() ? 'stale' : 'storage' };
    }
    if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) {
      return { status: 'storage' };
    }

    let snapshot: {
      readonly requested: AttachmentCacheEntry | null;
      readonly quota: AttachmentCacheQuotaSnapshot;
    } | null;
    try {
      snapshot = scope
        ? await scope.runTracked(() =>
            withDbTransaction(
              db,
              async () => ({
                requested: await getAttachmentCacheEntry(db, path),
                quota: await getAttachmentCacheQuotaSnapshot(db, ATTACHMENT_CACHE_MAX_FILES),
              }),
              () => scope.isCurrent(),
            ),
          )
        : await withDbTransaction(db, async () => ({
            requested: await getAttachmentCacheEntry(db, path),
            quota: await getAttachmentCacheQuotaSnapshot(db, ATTACHMENT_CACHE_MAX_FILES),
          }));
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError && scope) snapshot = null;
      else throw error;
    }
    if (snapshot === null) return { status: 'stale' };
    // Existing-path reuse is handled before admission. Never overwrite or double-count a ledger
    // path that still reached this new-download planner.
    if (snapshot.requested !== null) return { status: 'busy' };

    const pendingWriteBytes = this.reservationBytes();
    const protectedPaths = new Set<string>([
      ...this.reservations.keys(),
      ...this.protections.keys(),
      ...deniedPaths,
    ]);
    const plan = planAttachmentCacheAdmission({
      usage: snapshot.quota.usage,
      pendingWriteBytes,
      incomingBytes: maxBytes,
      availableBytes,
      now: this.now(),
      candidates: snapshot.quota.candidates,
      protectedPaths,
    });
    if (!plan.allowed) {
      // A bounded snapshot never guesses about omitted rows. Retire only paths the pure planner
      // proved sufficient; otherwise reject and let recovery/user action create capacity.
      return { status: 'storage' };
    }

    if (plan.retirePaths.length === 0) {
      if (scope && !scope.isCurrent()) return { status: 'stale' };
      if (this.reservations.has(path)) return { status: 'busy' };
      let created: boolean | null;
      try {
        created = scope
          ? await scope.runTracked(() =>
              withDbTransaction(
                db,
                (context) =>
                  createAttachmentCacheReservation(context, {
                    path,
                    maxBytes,
                    createdAt: this.now(),
                  }),
                () => scope.isCurrent(),
              ),
            )
          : await withDbTransaction(db, (context) =>
              createAttachmentCacheReservation(context, {
                path,
                maxBytes,
                createdAt: this.now(),
              }),
            );
      } catch (error) {
        if (error instanceof DbCommitGuardRejectedError && scope) {
          return { status: 'stale' };
        }
        throw error;
      }
      if (created === null) return { status: 'stale' };
      if (!created) return { status: 'replan' };
      const record: ReservationRecord = {
        token: Symbol(path),
        path,
        maxBytes,
        generation: scope?.generation ?? 'unscoped',
        acceptsProtections: false,
      };
      this.reservations.set(path, record);
      return { status: 'reserved', reservation: this.publicReservation(db, record, scope) };
    }

    const claimPaths = plan.retirePaths
      .filter(
        (candidate) =>
          !this.reservations.has(candidate) &&
          !this.protections.has(candidate) &&
          !this.pendingRetirements.has(candidate) &&
          !this.retirementOwners.has(candidate),
      )
      .slice(0, MAX_RETIREMENT_CLAIM_PATHS);
    if (claimPaths.length === 0) {
      plan.retirePaths.forEach((candidate) => deniedPaths.add(candidate));
      return { status: 'replan' };
    }

    // Block new synchronous handoff pins before the transaction begins. Any caller that races this
    // point receives null and never believes it owns a path whose DB references are being cleared.
    claimPaths.forEach((candidate) => this.pendingRetirements.add(candidate));
    let claim: AttachmentCacheRetirementClaim | null;
    try {
      try {
        claim = scope
          ? await scope.runTracked(() =>
              withDbTransaction(
                db,
                (context) => claimAttachmentCachePathsForRetirement(context, claimPaths),
                () => scope.isCurrent(),
              ),
            )
          : await withDbTransaction(db, (context) =>
              claimAttachmentCachePathsForRetirement(context, claimPaths),
            );
      } catch (error) {
        if (error instanceof DbCommitGuardRejectedError && scope) claim = null;
        else throw error;
      }
    } finally {
      claimPaths.forEach((candidate) => this.pendingRetirements.delete(candidate));
    }
    if (claim === null) return { status: 'stale' };
    if (claim.status === 'refused') {
      claim.paths.forEach((candidate) => deniedPaths.add(candidate));
      return { status: 'replan' };
    }

    const records = claim.paths.map((candidate) => {
      const record = { token: Symbol(candidate), path: candidate };
      this.retirementOwners.set(candidate, record);
      return record;
    });
    return { status: 'retire', records };
  }

  private async planConformanceStep(
    db: AppDatabase,
    scope: AttachmentCacheReservationScope | undefined,
    deniedPaths: Set<string>,
  ): Promise<ConformanceStep> {
    if (scope && !scope.isCurrent()) return { status: 'stale' };

    let availableBytes: number;
    try {
      availableBytes = await this.io.getAvailableBytes();
    } catch {
      return { status: scope && !scope.isCurrent() ? 'stale' : 'blocked' };
    }
    if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) {
      return scope && !scope.isCurrent() ? { status: 'stale' } : { status: 'blocked' };
    }

    let snapshot: AttachmentCacheQuotaSnapshot | null;
    try {
      snapshot = scope
        ? await scope.runTracked(() =>
            withDbTransaction(
              db,
              () => getAttachmentCacheQuotaSnapshot(db, ATTACHMENT_CACHE_MAX_FILES),
              () => scope.isCurrent(),
            ),
          )
        : await withDbTransaction(db, () =>
            getAttachmentCacheQuotaSnapshot(db, ATTACHMENT_CACHE_MAX_FILES),
          );
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError && scope) snapshot = null;
      else throw error;
    }
    if (snapshot === null) return { status: 'stale' };

    const protectedPaths = new Set<string>([
      ...this.reservations.keys(),
      ...this.protections.keys(),
      ...this.pendingRetirements,
      ...this.retirementOwners.keys(),
      ...deniedPaths,
    ]);
    const plan = planAttachmentCacheConformance({
      usage: snapshot.usage,
      availableBytes,
      now: this.now(),
      candidates: snapshot.candidates,
      protectedPaths,
    });
    if (plan.withinQuota) {
      return scope && !scope.isCurrent() ? { status: 'stale' } : { status: 'within_quota' };
    }

    const claimPaths = plan.retirePaths
      .filter(
        (path) =>
          !this.reservations.has(path) &&
          !this.protections.has(path) &&
          !this.pendingRetirements.has(path) &&
          !this.retirementOwners.has(path),
      )
      .slice(0, MAX_RETIREMENT_CLAIM_PATHS);
    if (claimPaths.length === 0) {
      return scope && !scope.isCurrent() ? { status: 'stale' } : { status: 'blocked' };
    }

    // Exclude new synchronous UI/send pins before the short DB claim begins. The claim's own
    // outgoing/reference guards remain authoritative and may still refuse this exact batch.
    claimPaths.forEach((path) => this.pendingRetirements.add(path));
    let claim: AttachmentCacheRetirementClaim | null;
    try {
      try {
        claim = scope
          ? await scope.runTracked(() =>
              withDbTransaction(
                db,
                (context) => claimAttachmentCachePathsForRetirement(context, claimPaths),
                () => scope.isCurrent(),
              ),
            )
          : await withDbTransaction(db, (context) =>
              claimAttachmentCachePathsForRetirement(context, claimPaths),
            );
      } catch (error) {
        if (error instanceof DbCommitGuardRejectedError && scope) claim = null;
        else throw error;
      }
    } finally {
      claimPaths.forEach((path) => this.pendingRetirements.delete(path));
    }
    if (claim === null) return { status: 'stale' };
    if (claim.status === 'refused') {
      claim.paths.forEach((path) => deniedPaths.add(path));
      return { status: 'replan', skipped: claim.paths.length };
    }

    const records = claim.paths.map((path) => {
      const record = { token: Symbol(path), path };
      this.retirementOwners.set(path, record);
      return record;
    });
    return { status: 'retire', records };
  }

  private async reuseProtected(
    db: AppDatabase,
    path: string,
    scope?: AttachmentCacheReservationScope,
  ): Promise<AttachmentCacheReuseResult> {
    if (scope && !scope.isCurrent()) return { status: 'stale' };

    let stat: AttachmentCacheFileStat;
    try {
      stat = await this.io.statFile(path);
    } catch {
      return { status: scope && !scope.isCurrent() ? 'stale' : 'unavailable' };
    }
    if (scope && !scope.isCurrent()) return { status: 'stale' };
    if (
      typeof stat.exists !== 'boolean' ||
      !Number.isSafeInteger(stat.bytes) ||
      stat.bytes < 0 ||
      (!stat.exists && stat.bytes !== 0) ||
      (stat.exists && stat.bytes === 0)
    ) {
      return { status: 'unavailable' };
    }

    const observedAt = this.now();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) return { status: 'unavailable' };
    let result: AttachmentCacheReuseResult | null;
    try {
      if (scope) {
        result = await scope.runTracked(() =>
          withDbTransaction(
            db,
            async (context): Promise<AttachmentCacheReuseResult> => {
              if (stat.exists) {
                const access = await recordAttachmentCacheAccess(context, {
                  path,
                  bytes: stat.bytes,
                  observedAt,
                  touchIntervalMs: ATTACHMENT_CACHE_ACCESS_TOUCH_INTERVAL_MS,
                });
                return { status: access === 'not_active' ? 'busy' : 'hit' };
              }

              const entry = await getAttachmentCacheEntry(db, path);
              if (entry === null) return { status: 'missing' };
              if (entry.state !== 'active') return { status: 'busy' };
              const repaired = await repairMissingActiveAttachmentCacheEntry(context, path);
              if (repaired === null) {
                throw new Error(
                  'Active attachment cache entry changed during missing-file repair.',
                );
              }
              return { status: 'missing' };
            },
            () => scope.isCurrent(),
          ),
        );
      } else {
        result = await withDbTransaction(
          db,
          async (context): Promise<AttachmentCacheReuseResult> => {
            if (stat.exists) {
              const access = await recordAttachmentCacheAccess(context, {
                path,
                bytes: stat.bytes,
                observedAt,
                touchIntervalMs: ATTACHMENT_CACHE_ACCESS_TOUCH_INTERVAL_MS,
              });
              return { status: access === 'not_active' ? 'busy' : 'hit' };
            }

            const entry = await getAttachmentCacheEntry(db, path);
            if (entry === null) return { status: 'missing' };
            if (entry.state !== 'active') return { status: 'busy' };
            const repaired = await repairMissingActiveAttachmentCacheEntry(context, path);
            if (repaired === null) {
              throw new Error('Active attachment cache entry changed during missing-file repair.');
            }
            return { status: 'missing' };
          },
        );
      }
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError && scope) {
        return { status: 'stale' };
      }
      throw error;
    }
    return result ?? { status: 'stale' };
  }

  private reservationBytes(): number {
    let bytes = 0;
    for (const reservation of this.reservations.values()) {
      if (reservation.maxBytes > Number.MAX_SAFE_INTEGER - bytes) {
        return Number.MAX_SAFE_INTEGER;
      }
      bytes += reservation.maxBytes;
    }
    return bytes;
  }

  private publicReservation(
    db: AppDatabase,
    record: ReservationRecord,
    scope?: AttachmentCacheReservationScope,
  ): AttachmentCacheReservation {
    let released = false;
    return {
      path: record.path,
      maxBytes: record.maxBytes,
      generation: record.generation,
      beginProtectionHandoff: () => {
        if (released) return false;
        const current = this.reservations.get(record.path);
        if (current?.token !== record.token) return false;
        current.acceptsProtections = true;
        return true;
      },
      rollbackProtectionHandoff: () => {
        if (released) return false;
        const current = this.reservations.get(record.path);
        if (current?.token !== record.token) return false;
        current.acceptsProtections = false;
        return true;
      },
      release: async () => {
        if (released) return;
        released = true;
        await this.runExclusive(async () => {
          if (this.reservations.get(record.path)?.token === record.token) {
            this.reservations.delete(record.path);
          }
        });
        // A successful commit changed this row to active, so it is not returned here. A failed,
        // cancelled, or process-interrupted transfer leaves `reserved`; recover it through the
        // same exact native delete + durable retry path as ordinary retirement.
        await this.drainDueRetirements(db, { scope, limit: MAX_RETIREMENT_CLAIM_PATHS });
      },
    };
  }

  private async settleRetirement(
    db: AppDatabase,
    record: RetirementRecord,
    scope?: AttachmentCacheReservationScope,
  ): Promise<'confirmed' | 'failed' | 'stale'> {
    let nativeConfirmedAbsent = false;
    try {
      const result = await this.io.deleteFile(record.path);
      nativeConfirmedAbsent = result.status === 'deleted' || result.status === 'missing';
    } catch {
      nativeConfirmedAbsent = false;
    }

    let outcome: 'confirmed' | 'failed' | 'stale' = 'failed';
    try {
      if (scope) {
        // Account-scoped download and recovery settlement expose their transaction owner at the
        // exact write site. Unscoped standalone settlement retains the direct owner below.
        if (nativeConfirmedAbsent) {
          const confirmed = await scope.runTracked(() =>
            withDbTransaction(
              db,
              (context) => confirmAttachmentCacheEntryDeleted(context, record.path),
              () => scope.isCurrent(),
            ),
          );
          outcome = confirmed === null ? 'stale' : confirmed ? 'confirmed' : 'failed';
        } else {
          const scheduled = await scope.runTracked(() =>
            withDbTransaction(
              db,
              (context) => scheduleAttachmentCacheRetirementRetry(context, record.path, this.now()),
              () => scope.isCurrent(),
            ),
          );
          outcome = scheduled === null && !scope.isCurrent() ? 'stale' : 'failed';
        }
      } else if (nativeConfirmedAbsent) {
        const confirmed = await withDbTransaction(db, (context) =>
          confirmAttachmentCacheEntryDeleted(context, record.path),
        );
        outcome = confirmed ? 'confirmed' : 'failed';
      } else {
        await withDbTransaction(db, (context) =>
          scheduleAttachmentCacheRetirementRetry(context, record.path, this.now()),
        );
        outcome = 'failed';
      }
    } catch {
      // The file may already be absent while confirmation failed. Keep the retiring row charged;
      // startup recovery will observe native `missing` and confirm it on a later authorized run.
      outcome = scope && !scope.isCurrent() ? 'stale' : 'failed';
    } finally {
      await this.runExclusive(async () => {
        if (this.retirementOwners.get(record.path)?.token === record.token) {
          this.retirementOwners.delete(record.path);
        }
      });
    }
    return outcome;
  }

  /** Claim a FIFO gate slot synchronously; its promise never remains rejected/poisoned. */
  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(task).finally(release);
  }
}

/** One process-wide coordinator owns all reservation/path identities. */
export const attachmentCacheCoordinator = new AttachmentCacheCoordinator();
