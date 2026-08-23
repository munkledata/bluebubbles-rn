/** Fixed global policy for completed ordinary attachment downloads. */
export const ATTACHMENT_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const ATTACHMENT_CACHE_MAX_FILES = 4096;
export const ATTACHMENT_CACHE_MIN_FREE_BYTES = 512 * 1024 * 1024;
export const ATTACHMENT_CACHE_RECENT_GRACE_MS = 10 * 60 * 1000;

export interface AttachmentCacheQuotaUsage {
  readonly bytes: number;
  readonly files: number;
}

export interface AttachmentCacheEvictionCandidate {
  readonly path: string;
  readonly bytes: number;
  readonly lastUsedAt: number;
}

export interface AttachmentCacheQuotaPlanInput {
  /** Ledger totals, including `retiring` rows until native deletion is confirmed. */
  readonly usage: AttachmentCacheQuotaUsage;
  /** Max bytes of durable `reserved` rows whose native writes have not reached disk yet. */
  readonly pendingWriteBytes: number;
  /** Conservative maximum this new transfer may write. */
  readonly incomingBytes: number;
  /** Native free bytes before any current-process reservation is written. */
  readonly availableBytes: number;
  readonly now: number;
  /** Active ledger rows ordered by the planner itself; retiring rows are never candidates. */
  readonly candidates: readonly AttachmentCacheEvictionCandidate[];
  /** In-flight/current/outgoing paths that must never be selected. */
  readonly protectedPaths?: ReadonlySet<string>;
}

export interface AttachmentCacheConformancePlanInput {
  /** Ledger totals across every state: `active`, `reserved`, and `retiring`. */
  readonly usage: AttachmentCacheQuotaUsage;
  /** Current native free bytes. No hypothetical incoming file is subtracted. */
  readonly availableBytes: number;
  readonly now: number;
  /** Active ledger rows only; reserved/retiring rows stay charged but are never candidates. */
  readonly candidates: readonly AttachmentCacheEvictionCandidate[];
  /** In-flight/current/outgoing paths that must never be selected. */
  readonly protectedPaths?: ReadonlySet<string>;
}

export type AttachmentCacheQuotaPlan =
  | {
      readonly allowed: true;
      readonly retirePaths: readonly string[];
      readonly projectedBytes: number;
      readonly projectedFiles: number;
      readonly projectedAvailableBytes: number;
    }
  | {
      readonly allowed: false;
      readonly reason: 'incoming_too_large' | 'insufficient_capacity';
    };

/**
 * A current-usage plan never predicts success from deletion alone. `withinQuota` describes the
 * input snapshot; the coordinator must exact-delete selected paths and take another snapshot.
 */
export interface AttachmentCacheConformancePlan {
  readonly withinQuota: boolean;
  /** Whether every current shortfall can be covered by the returned eligible paths. */
  readonly canConform: boolean;
  /** A deterministic safe prefix; it may be partial when protected/non-active rows block success. */
  readonly retirePaths: readonly string[];
  readonly byteShortfall: number;
  readonly fileShortfall: number;
  readonly freeSpaceShortfall: number;
  readonly projectedBytes: number;
  readonly projectedFiles: number;
  readonly projectedAvailableBytes: number;
}

function isNonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function requireUsage(value: AttachmentCacheQuotaUsage, label: string): void {
  if (!isNonnegativeSafeInteger(value.bytes) || !isNonnegativeSafeInteger(value.files)) {
    throw new RangeError(`${label} must contain non-negative safe integers.`);
  }
}

function addSaturated(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (value > Number.MAX_SAFE_INTEGER - total) return Number.MAX_SAFE_INTEGER;
    total += value;
  }
  return total;
}

function requirePlanSnapshot(
  input: {
    readonly usage: AttachmentCacheQuotaUsage;
    readonly availableBytes: number;
    readonly now: number;
    readonly candidates: readonly AttachmentCacheEvictionCandidate[];
    readonly protectedPaths?: ReadonlySet<string>;
  },
  label: string,
): void {
  requireUsage(input.usage, `${label} usage`);
  if (!isNonnegativeSafeInteger(input.availableBytes)) {
    throw new RangeError(`${label} availableBytes must be a non-negative safe integer.`);
  }
  if (!isNonnegativeSafeInteger(input.now)) {
    throw new RangeError(`${label} now must be a non-negative safe integer.`);
  }

  const seen = new Set<string>();
  for (const candidate of input.candidates) {
    if (
      typeof candidate.path !== 'string' ||
      candidate.path.length === 0 ||
      !isNonnegativeSafeInteger(candidate.bytes) ||
      !isNonnegativeSafeInteger(candidate.lastUsedAt)
    ) {
      throw new RangeError(`${label} candidate fields are invalid.`);
    }
    if (seen.has(candidate.path)) {
      throw new RangeError(`${label} candidates must have unique paths.`);
    }
    seen.add(candidate.path);
  }
  if (input.protectedPaths) {
    for (const path of input.protectedPaths) {
      if (typeof path !== 'string' || path.length === 0) {
        throw new RangeError(`${label} protected paths must not be empty.`);
      }
    }
  }
}

function eligibleCandidates(
  input: Pick<AttachmentCacheConformancePlanInput, 'candidates' | 'now' | 'protectedPaths'>,
): AttachmentCacheEvictionCandidate[] {
  const recentCutoff = Math.max(0, input.now - ATTACHMENT_CACHE_RECENT_GRACE_MS);
  const protectedPaths = input.protectedPaths ?? new Set<string>();
  return (
    input.candidates
      .filter(
        (candidate) => candidate.lastUsedAt < recentCutoff && !protectedPaths.has(candidate.path),
      )
      // Do not use localeCompare here: locale/collator differences would choose a different victim
      // on different Android devices. JavaScript string ordering is stable UTF-16 code-unit order.
      .sort((left, right) => {
        const byTime = left.lastUsedAt - right.lastUsedAt;
        if (byTime !== 0) return byTime;
        return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
      })
  );
}

/**
 * Plan one new physical cache file without mutating the DB or filesystem.
 *
 * Selection is deterministic least-recently-used order (`lastUsedAt`, then exact path). A path is
 * eligible only after the recent-use grace and when the caller did not protect it. The plan is
 * conservative: already-retiring bytes remain in `usage`, and all process reservations are charged
 * both against the quota and against native free space until they settle.
 */
export function planAttachmentCacheAdmission(
  input: AttachmentCacheQuotaPlanInput,
): AttachmentCacheQuotaPlan {
  requirePlanSnapshot(input, 'Attachment cache');
  if (!isNonnegativeSafeInteger(input.pendingWriteBytes)) {
    throw new RangeError('Attachment cache pendingWriteBytes must be a non-negative safe integer.');
  }
  if (!isNonnegativeSafeInteger(input.incomingBytes) || input.incomingBytes === 0) {
    throw new RangeError('Attachment cache incomingBytes must be a positive safe integer.');
  }
  if (input.incomingBytes > ATTACHMENT_CACHE_MAX_BYTES) {
    return { allowed: false, reason: 'incoming_too_large' };
  }

  const projectedBytesBeforeEviction = addSaturated(input.usage.bytes, input.incomingBytes);
  const projectedFilesBeforeEviction = addSaturated(input.usage.files, 1);
  const pendingAndIncomingBytes = addSaturated(input.pendingWriteBytes, input.incomingBytes);
  const byteQuotaShortfall = Math.max(0, projectedBytesBeforeEviction - ATTACHMENT_CACHE_MAX_BYTES);
  const fileQuotaShortfall = Math.max(0, projectedFilesBeforeEviction - ATTACHMENT_CACHE_MAX_FILES);
  const freeSpaceShortfall = Math.max(
    0,
    addSaturated(ATTACHMENT_CACHE_MIN_FREE_BYTES, pendingAndIncomingBytes) - input.availableBytes,
  );
  const bytesToFree = Math.max(byteQuotaShortfall, freeSpaceShortfall);

  if (bytesToFree === 0 && fileQuotaShortfall === 0) {
    return {
      allowed: true,
      retirePaths: [],
      projectedBytes: projectedBytesBeforeEviction,
      projectedFiles: projectedFilesBeforeEviction,
      projectedAvailableBytes: input.availableBytes - pendingAndIncomingBytes,
    };
  }

  const eligible = eligibleCandidates(input);

  const retirePaths: string[] = [];
  let freedBytes = 0;
  for (const candidate of eligible) {
    if (freedBytes >= bytesToFree && retirePaths.length >= fileQuotaShortfall) break;
    retirePaths.push(candidate.path);
    freedBytes = addSaturated(freedBytes, candidate.bytes);
  }

  if (freedBytes < bytesToFree || retirePaths.length < fileQuotaShortfall) {
    return { allowed: false, reason: 'insufficient_capacity' };
  }

  return {
    allowed: true,
    retirePaths,
    projectedBytes: Math.max(0, projectedBytesBeforeEviction - freedBytes),
    projectedFiles: Math.max(0, projectedFilesBeforeEviction - retirePaths.length),
    projectedAvailableBytes: Math.max(
      0,
      input.availableBytes - pendingAndIncomingBytes + freedBytes,
    ),
  };
}

/**
 * Plan retirement for the cache that exists now, without pretending another file will be added.
 *
 * All ledger states remain charged through `usage`. Only old, active, unprotected candidates can
 * be returned. When those candidates cannot cover every shortfall, the safe partial prefix is
 * still returned so a coordinator may reclaim it and then re-read authoritative state.
 */
export function planAttachmentCacheConformance(
  input: AttachmentCacheConformancePlanInput,
): AttachmentCacheConformancePlan {
  requirePlanSnapshot(input, 'Attachment cache conformance');

  const byteShortfall = Math.max(0, input.usage.bytes - ATTACHMENT_CACHE_MAX_BYTES);
  const fileShortfall = Math.max(0, input.usage.files - ATTACHMENT_CACHE_MAX_FILES);
  const freeSpaceShortfall = Math.max(0, ATTACHMENT_CACHE_MIN_FREE_BYTES - input.availableBytes);
  const bytesToFree = Math.max(byteShortfall, freeSpaceShortfall);
  const withinQuota = bytesToFree === 0 && fileShortfall === 0;
  if (withinQuota) {
    return {
      withinQuota: true,
      canConform: true,
      retirePaths: [],
      byteShortfall,
      fileShortfall,
      freeSpaceShortfall,
      projectedBytes: input.usage.bytes,
      projectedFiles: input.usage.files,
      projectedAvailableBytes: input.availableBytes,
    };
  }

  const retirePaths: string[] = [];
  let freedBytes = 0;
  for (const candidate of eligibleCandidates(input)) {
    if (freedBytes >= bytesToFree && retirePaths.length >= fileShortfall) break;
    retirePaths.push(candidate.path);
    freedBytes = addSaturated(freedBytes, candidate.bytes);
  }

  return {
    withinQuota: false,
    canConform: freedBytes >= bytesToFree && retirePaths.length >= fileShortfall,
    retirePaths,
    byteShortfall,
    fileShortfall,
    freeSpaceShortfall,
    projectedBytes: Math.max(0, input.usage.bytes - freedBytes),
    projectedFiles: Math.max(0, input.usage.files - retirePaths.length),
    projectedAvailableBytes: addSaturated(input.availableBytes, freedBytes),
  };
}
