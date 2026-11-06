/**
 * Shared account-lifecycle state and the small guards every area of the old bootstrap module used.
 *
 * Connect (connect.ts), the foreground boot stages (bootstrap.ts) and the Disconnect cleanup
 * (accountCleanup.ts) coordinate through these ten variables; the ES module system cannot share a
 * mutable `let` binding across files, so they live on one object. Named operations can replace the
 * raw fields later; this split keeps every read and write exactly where it was.
 */

import { CREDENTIAL_REMOVAL_FAILURE_MESSAGE, logger } from '@core/secure';
import type { ReadDb } from '@db/types';
import { recoverAttachmentCache } from './download/attachmentCacheRecovery';
import {
  pauseRealtimeDeliveries,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';
import type { ForegroundSessionSnapshot } from './boot/durableSession';
import type { BootIssue } from './boot/bootStateMachine';
import type { ForgetRun } from './accountCleanup';

export interface AccountLifecycleState {
  /** Disconnect increments this synchronously, revoking boot/candidate work suspended in async I/O. */
  connectionAttemptEpoch: number;
  /** In-process proof that the current revoked epoch already completed its full destructive sweep. */
  lastSuccessfulForgetEpoch: number;
  /** A retired boot closes admission synchronously; its bounded successor check owns the drain. */
  foregroundDeliveryDrain: Promise<void> | null;
  /** A timed-out SecureStore candidate may have one native mutation still settling. */
  connectCandidateQuarantine: Promise<void> | null;
  /** Every active candidate commit, including the pre-timeout window Disconnect must join. */
  activeConnectCandidate: Promise<void> | null;
  /** A first SQLCipher open cannot be safely replaced while its native promise is still pending. */
  connectDatabaseQuarantine: Promise<void> | null;
  /** Public Disconnect revokes the one explicit Connect even before that attempt captures an epoch. */
  activeConnectRevoker: (() => void) | null;
  /** Late destructive cleanup must settle, then a whole new sweep must pass, before account B. */
  accountCleanupQuarantine: Promise<void> | null;
  /** Only one candidate may validate and commit the four-part SecureStore tuple at a time. */
  connectInFlight: boolean;
  /** The ONE wipe currently running (see {@link forget}). */
  forgetInFlight: ForgetRun | null;
}

/** The one shared instance; every reader and writer in connect.ts, bootstrap.ts and accountCleanup.ts uses it. */
export const lifecycle: AccountLifecycleState = {
  connectionAttemptEpoch: 0,
  lastSuccessfulForgetEpoch: -1,
  foregroundDeliveryDrain: null,
  connectCandidateQuarantine: null,
  activeConnectCandidate: null,
  connectDatabaseQuarantine: null,
  activeConnectRevoker: null,
  accountCleanupQuarantine: null,
  connectInFlight: false,
  forgetInFlight: null,
};

export const ACCOUNT_STATE_UNAVAILABLE_MESSAGE =
  'Gator could not safely verify the saved connection. Restart the app and try again. No saved data was changed.';
export const RESIDUAL_CLEANUP_FAILURE_MESSAGE =
  'Gator could not safely finish clearing the previous connection. Restart the app and try again before connecting.';
export const CREDENTIAL_UPGRADE_RETIREMENT_FAILURE_MESSAGE =
  'Scoped credential retirement for the previous connection could not be confirmed.';
export const SETTINGS_HYDRATION_FAILURE_MESSAGE =
  'Gator could not safely load local settings. Restart the app and try again.';
/** F-12: the Keystore key is gone but the encrypted file remains; no retry can open it. */
export const DATABASE_KEY_LOST_MESSAGE =
  'Gator’s encrypted storage can’t be opened. Clear Gator’s app data in Android Settings and connect again.';
const ATTACHMENT_CACHE_RECOVERY_DEADLINE_MS = 45_000;
// Review item 888: a restart repeats the same failed check, so point to the repair instead.
const ATTACHMENT_CACHE_PAUSED_MESSAGE =
  'New downloads are paused. To fix it, open Settings → Privacy & Storage → Repair Downloads.';
export const FOREGROUND_DELIVERY_CLEANUP_DEADLINE_MS = 5_000;
const FOREGROUND_DELIVERY_CLEANUP_FAILURE_MESSAGE =
  'Gator is still finishing work from the previous startup attempt. Try again.';
export type DeadlineSettlement<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'timeout' };
/** Bound UI orchestration while still consuming a native promise that may settle much later. */
export async function settleWithinDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<DeadlineSettlement<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settlement = operation.then<DeadlineSettlement<T>, DeadlineSettlement<T>>(
    (value) => ({ kind: 'value', value }),
    (error: unknown) => ({ kind: 'error', error }),
  );
  const deadline = new Promise<DeadlineSettlement<T>>((resolve) => {
    timeout = setTimeout(() => {
      try {
        // Revoke the caller's late-commit guard before waking its timeout continuation.
        onTimeout?.();
      } finally {
        resolve({ kind: 'timeout' });
      }
    }, timeoutMs);
  });
  try {
    return await Promise.race([settlement, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
export function quarantineConnectCandidate(operation: Promise<unknown>): void {
  const quarantine = operation.then(
    () => undefined,
    () => undefined,
  );
  lifecycle.connectCandidateQuarantine = quarantine;
  void quarantine.then(() => {
    if (lifecycle.connectCandidateQuarantine === quarantine)
      lifecycle.connectCandidateQuarantine = null;
  });
}
export function trackConnectCandidate(operation: Promise<unknown>): void {
  const tracked = operation.then(
    () => undefined,
    () => undefined,
  );
  lifecycle.activeConnectCandidate = tracked;
  void tracked.then(() => {
    if (lifecycle.activeConnectCandidate === tracked) lifecycle.activeConnectCandidate = null;
  });
}
export function quarantineConnectDatabase(operation: Promise<unknown>): void {
  const quarantine = operation.then(
    () => undefined,
    () => undefined,
  );
  lifecycle.connectDatabaseQuarantine = quarantine;
  void quarantine.then(() => {
    if (lifecycle.connectDatabaseQuarantine === quarantine)
      lifecycle.connectDatabaseQuarantine = null;
  });
}
export function quarantineAccountCleanup(operation: Promise<unknown>): void {
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  const prior = lifecycle.accountCleanupQuarantine;
  const quarantine = prior ? Promise.all([prior, settled]).then(() => undefined) : settled;
  lifecycle.accountCleanupQuarantine = quarantine;
  void quarantine.then(() => {
    if (lifecycle.accountCleanupQuarantine === quarantine)
      lifecycle.accountCleanupQuarantine = null;
  });
}
export function closeForegroundDeliveryAdmission(): void {
  const drain = pauseRealtimeDeliveries();
  lifecycle.foregroundDeliveryDrain = drain;
  void drain.then(
    () => {
      if (lifecycle.foregroundDeliveryDrain === drain) lifecycle.foregroundDeliveryDrain = null;
    },
    (error: unknown) => {
      if (lifecycle.foregroundDeliveryDrain === drain) lifecycle.foregroundDeliveryDrain = null;
      logger.warn('[boot] realtime delivery pause failed during cleanup', error);
    },
  );
}
export async function requirePriorForegroundDeliveryDrain(): Promise<void> {
  const drain = lifecycle.foregroundDeliveryDrain;
  if (!drain) return;
  if (!(await withDeadline(drain, FOREGROUND_DELIVERY_CLEANUP_DEADLINE_MS))) {
    throw new ForegroundBootOperationalError(
      'prior-realtime-drain-incomplete',
      FOREGROUND_DELIVERY_CLEANUP_FAILURE_MESSAGE,
    );
  }
}
/** Private, password-bearing state carried only inside one foreground coordinator run. */
export interface ForegroundBootAttempt {
  readonly activationEpoch: number;
  readonly snapshot: ForegroundSessionSnapshot;
  readonly resources: { db: ReadDb | null };
}
export class ForegroundBootOperationalError extends Error {
  constructor(
    readonly code: string,
    readonly userMessage: string,
    options: { cause?: unknown } = {},
  ) {
    super(userMessage, options);
    this.name = 'ForegroundBootOperationalError';
  }
}
/**
 * Terminal: the encrypted database exists but its Keystore key is gone (F-12). Retrying the stage
 * cannot help; the owner has to clear app data and connect again.
 */
export class ForegroundBootKeyLostError extends Error {
  readonly code = 'database-key-lost';
  readonly userMessage = DATABASE_KEY_LOST_MESSAGE;
  constructor(cause: unknown) {
    super(DATABASE_KEY_LOST_MESSAGE, { cause });
    this.name = 'ForegroundBootKeyLostError';
  }
}
export class ForegroundBootSupersededError extends Error {
  constructor() {
    super('Foreground boot ownership was superseded.');
    this.name = 'ForegroundBootSupersededError';
  }
}
/**
 * Disconnect finished every local step; only the previous server's confirmation that it revoked
 * this phone's scoped credential is missing, and the exact bearer stays encrypted under `forgotten`
 * for the next retry. Startup shows setup for this case alone, because setup's connect() keeps
 * refusing until that bearer is revoked or forgotten on this phone only. It carries the shared
 * message, so the Disconnect and connect wording is unchanged.
 */
export class ServerRevocationPendingError extends Error {
  constructor() {
    super(CREDENTIAL_UPGRADE_RETIREMENT_FAILURE_MESSAGE);
    this.name = 'ServerRevocationPendingError';
  }
}
/**
 * Reconcile persistent media before account UI, sync, or socket work can use it.
 *
 * Native recovery is deliberately fail-closed only for the download cache: an old Android build
 * or a temporarily unavailable file bridge must not make the encrypted offline inbox unusable.
 * The readiness gate remains closed, so persistent downloads reject until a later authorized boot
 * completes recovery. A stale lease means Disconnect owns the transition and activation must stop.
 */
async function recoverAttachmentCacheForActivation(
  db: ReadDb,
  lease: RealtimeDeliveryLease,
  source: 'boot' | 'connect',
): Promise<'ready' | 'stale' | 'unavailable'> {
  try {
    const result = await recoverAttachmentCache(db, lease);
    return result.status;
  } catch (error) {
    if (!lease.isCurrent()) return 'stale';
    logger.warn(
      `[${source}] attachment cache recovery failed; persistent downloads remain disabled`,
      error,
    );
    return 'unavailable';
  }
}
export async function recoverAttachmentCacheWithinDeadline(
  db: ReadDb,
  deliveryLease: RealtimeDeliveryLease,
  isAuthorized: () => boolean,
  source: 'boot' | 'connect',
  reportIssue: (issue: BootIssue) => void,
): Promise<'ready' | 'stale' | 'unavailable' | 'timeout'> {
  let deadlineCurrent = true;
  const lease: RealtimeDeliveryLease = {
    generation: deliveryLease.generation,
    isCurrent: () => deadlineCurrent && deliveryLease.isCurrent() && isAuthorized(),
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const recovery = recoverAttachmentCacheForActivation(db, lease, source);
  const timed = new Promise<'timeout'>((resolve) => {
    timeout = setTimeout(() => {
      // Revoke the exact recovery lease before waking the caller. A late native page may settle,
      // but it can no longer commit a manifest plan or reopen persistent-download readiness.
      deadlineCurrent = false;
      resolve('timeout');
    }, ATTACHMENT_CACHE_RECOVERY_DEADLINE_MS);
  });
  const outcome = await Promise.race([recovery, timed]);
  if (timeout !== undefined) clearTimeout(timeout);

  if (outcome === 'timeout') {
    reportIssue({
      stage: 'attachment-cache',
      level: 'degraded',
      code: 'attachment-cache-recovery-timeout',
      userMessage: ATTACHMENT_CACHE_PAUSED_MESSAGE,
    });
    void recovery.catch((error) => {
      logger.debug(`[${source}] late attachment cache recovery failed after timeout`, error);
    });
    return outcome;
  }
  if (outcome === 'unavailable') {
    reportIssue({
      stage: 'attachment-cache',
      level: 'degraded',
      code: 'attachment-cache-recovery-unavailable',
      userMessage: ATTACHMENT_CACHE_PAUSED_MESSAGE,
    });
  }
  return outcome;
}
/** The previous server could not confirm revoking this phone's scoped credential. */
export const PREVIOUS_CREDENTIAL_UNREVOKED_MESSAGE =
  "Gator couldn't reach the previous server to remove this phone's access, so it can't safely " +
  'connect yet. If that server is gone for good, you can forget it on this phone only.';
/** True when a cleanup failed because a scoped credential's server revocation was not confirmed. */
export function isUnconfirmedCredentialRetirement(error: unknown): boolean {
  return error instanceof Error && error.message === CREDENTIAL_UPGRADE_RETIREMENT_FAILURE_MESSAGE;
}
export function disconnectFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message === CREDENTIAL_REMOVAL_FAILURE_MESSAGE) {
    return error.message;
  }
  return isUnconfirmedCredentialRetirement(error)
    ? PREVIOUS_CREDENTIAL_UNREVOKED_MESSAGE
    : RESIDUAL_CLEANUP_FAILURE_MESSAGE;
}
/** Await `p`, but give up after `ms` — returns false when the deadline won. */
export async function withDeadline(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  try {
    await Promise.race([
      p.then(() => {
        completed = true;
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    return completed;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
