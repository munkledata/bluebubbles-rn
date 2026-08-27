import { serverApi } from '@core/api';
import { isCleartext, sanitizeServerAddress } from '@core/config';
import { FCM_ENABLED } from '@core/realtime';
import {
  CREDENTIAL_REMOVAL_FAILURE_MESSAGE,
  hasActiveServerSession,
  logger,
  memoryLogSink,
  SERVER_SESSION_STATE,
} from '@core/secure';
import { clearLocalCache, listReminders, localCacheDirty } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { areCriticalSettingsHydrated, hydrateAllStores } from '@state/hydrateStores';
import { useSessionStore } from '@state/sessionStore';
import { accountRevocationMarker, candidateClient, http, vault } from './clients';
import { fileLogSink } from './logging/fileLogSink';
import { connectToServer } from './connection';
import { ensureDatabase, runSearchTextBackfillOnce } from './databaseControl';
import {
  invalidateAttachmentCacheRecoveryReadiness,
  recoverAttachmentCache,
} from './download/attachmentCacheRecovery';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';
import { getSocket, setSocket, startRealtime } from './realtimeControl';
import { stopDeviceNetworkWatch } from './networkReachability';
import { stopReachabilityWatch } from './reachability';
import { uploadRegistry } from './send/uploadControl';
import { resetSessionScopedState } from './sessionScopedState';
import { awaitSyncIdle, startSync } from './syncControl';
import {
  inspectDurableServerSession,
  isForegroundSessionSnapshot,
  sameForegroundSession,
  type DurableSessionInspection,
  type ForegroundSessionSnapshot,
} from './boot/durableSession';
import type { BootSessionOutcome, BootStageContext } from './boot/bootCoordinator';
import type { BootIssue } from './boot/bootStateMachine';
import {
  invalidateForegroundBootForAccountTransition,
  reportForegroundBootIssue,
  restartForegroundBootAfterAccountTransition,
} from './boot/foregroundBootInvalidation';

const ACCOUNT_STATE_UNAVAILABLE_MESSAGE =
  'Gator could not safely verify the saved connection. Restart the app and try again. No saved data was changed.';
const DIFFERENT_SAVED_ACCOUNT_MESSAGE =
  'Gator found a different saved connection. Restart the app to restore it, then use Disconnect before connecting to another server.';
const RESIDUAL_CLEANUP_FAILURE_MESSAGE =
  'Gator could not safely finish clearing the previous connection. Restart the app and try again before connecting.';
const FCM_TOKEN_RETIREMENT_FAILURE_MESSAGE =
  'Push notification retirement for the previous connection could not be confirmed.';
const REALTIME_DRAIN_FAILURE_MESSAGE =
  'In-flight account work from the previous connection did not stop in time.';
const SYNC_DRAIN_FAILURE_MESSAGE =
  'An in-flight sync from the previous connection did not stop in time.';
const DOWNLOAD_DRAIN_FAILURE_MESSAGE =
  'In-flight media downloads from the previous connection did not stop in time.';
const UPLOAD_DRAIN_FAILURE_MESSAGE =
  'In-flight media uploads from the previous connection did not stop in time.';
const NOTIFICATION_CLEANUP_FAILURE_MESSAGE =
  'Notifications from the previous connection could not be fully removed.';
const DATABASE_CLEANUP_FAILURE_MESSAGE =
  'Local data from the previous connection could not be fully removed.';
const MEDIA_CLEANUP_FAILURE_MESSAGE =
  'Cached media from the previous connection could not be fully removed.';
const SHORTCUT_CLEANUP_FAILURE_MESSAGE =
  'Direct Share shortcuts from the previous connection could not be fully removed.';
const LOG_CLEANUP_FAILURE_MESSAGE =
  'Diagnostic logs from the previous connection could not be fully removed.';
const IN_MEMORY_CLEANUP_FAILURE_MESSAGE =
  'In-memory state from the previous connection could not be fully retired.';
const SETTINGS_HYDRATION_FAILURE_MESSAGE =
  'Gator could not safely load local settings. Restart the app and try again.';
const DATABASE_BOOT_FAILURE_MESSAGE =
  'Gator could not open your encrypted messages. Try again. If this keeps happening, restart the app.';
const ATTACHMENT_CACHE_RECOVERY_DEADLINE_MS = 45_000;
const FOREGROUND_DELIVERY_CLEANUP_DEADLINE_MS = 5_000;
const CONNECT_ACCOUNT_GATE_DEADLINE_MS = 10_000;
const CONNECT_CANDIDATE_DEADLINE_MS = 45_000;
const CONNECT_DATABASE_DEADLINE_MS = 30_000;
const CONNECT_SETTINGS_DEADLINE_MS = 15_000;
const FOREGROUND_DELIVERY_CLEANUP_FAILURE_MESSAGE =
  'Gator is still finishing work from the previous startup attempt. Try again.';
const CONNECT_GATE_TIMEOUT_MESSAGE =
  'Gator is still checking previous account state. Try again in a moment.';
const CONNECT_CANDIDATE_TIMEOUT_MESSAGE =
  'The connection attempt took too long. Check the server and try again.';
const CONNECT_CANDIDATE_QUARANTINE_MESSAGE =
  'The previous connection attempt is still stopping. Try again in a moment.';
const CONNECT_DATABASE_QUARANTINE_MESSAGE =
  'Database startup is still pending. Fully close and reopen Gator before trying again.';
const CONNECT_DATABASE_TIMEOUT_MESSAGE =
  'Gator could not finish opening your encrypted messages. Fully close and reopen Gator to try again.';
const CONNECT_CANDIDATE_DRAIN_FAILURE_MESSAGE =
  'A previous connection attempt did not stop in time.';
const ACCOUNT_CLEANUP_QUARANTINE_MESSAGE =
  'Previous account cleanup is still pending. Fully close and reopen Gator before connecting again.';
const ACCOUNT_CLEANUP_QUARANTINE_FAILURE_MESSAGE =
  'A previous account cleanup operation did not stop in time.';
const CREDENTIAL_CLEANUP_TIMEOUT_MESSAGE = 'Secure credential retirement did not finish in time.';

type DeadlineSettlement<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'timeout' };

/** Bound UI orchestration while still consuming a native promise that may settle much later. */
async function settleWithinDeadline<T>(
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

/** Disconnect increments this synchronously, revoking boot/candidate work suspended in async I/O. */
let connectionAttemptEpoch = 0;
/** In-process proof that the current revoked epoch already completed its full destructive sweep. */
let lastSuccessfulForgetEpoch = -1;
/** A retired boot closes admission synchronously; its bounded successor check owns the drain. */
let foregroundDeliveryDrain: Promise<void> | null = null;
/** A timed-out SecureStore candidate may have one native mutation still settling. */
let connectCandidateQuarantine: Promise<void> | null = null;
/** A first SQLCipher open cannot be safely replaced while its native promise is still pending. */
let connectDatabaseQuarantine: Promise<void> | null = null;
/** Public Disconnect revokes the one explicit Connect even before that attempt captures an epoch. */
let activeConnectRevoker: (() => void) | null = null;
/** Late destructive cleanup must settle, then a whole new sweep must pass, before account B. */
let accountCleanupQuarantine: Promise<void> | null = null;

function quarantineConnectCandidate(operation: Promise<unknown>): void {
  const quarantine = operation.then(
    () => undefined,
    () => undefined,
  );
  connectCandidateQuarantine = quarantine;
  void quarantine.then(() => {
    if (connectCandidateQuarantine === quarantine) connectCandidateQuarantine = null;
  });
}

function quarantineConnectDatabase(operation: Promise<unknown>): void {
  const quarantine = operation.then(
    () => undefined,
    () => undefined,
  );
  connectDatabaseQuarantine = quarantine;
  void quarantine.then(() => {
    if (connectDatabaseQuarantine === quarantine) connectDatabaseQuarantine = null;
  });
}

function quarantineAccountCleanup(operation: Promise<unknown>): void {
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  const prior = accountCleanupQuarantine;
  const quarantine = prior ? Promise.all([prior, settled]).then(() => undefined) : settled;
  accountCleanupQuarantine = quarantine;
  void quarantine.then(() => {
    if (accountCleanupQuarantine === quarantine) accountCleanupQuarantine = null;
  });
}

function closeForegroundDeliveryAdmission(): void {
  const drain = pauseRealtimeDeliveries();
  foregroundDeliveryDrain = drain;
  void drain.then(
    () => {
      if (foregroundDeliveryDrain === drain) foregroundDeliveryDrain = null;
    },
    (error: unknown) => {
      if (foregroundDeliveryDrain === drain) foregroundDeliveryDrain = null;
      logger.warn('[boot] realtime delivery pause failed during cleanup', error);
    },
  );
}

async function requirePriorForegroundDeliveryDrain(): Promise<void> {
  const drain = foregroundDeliveryDrain;
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
  readonly resources: { db: AppDatabase | null };
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

export class ForegroundBootSupersededError extends Error {
  constructor() {
    super('Foreground boot ownership was superseded.');
    this.name = 'ForegroundBootSupersededError';
  }
}

export function isForegroundBootAttempt(value: unknown): value is ForegroundBootAttempt {
  if (!value || typeof value !== 'object' || !Object.isFrozen(value)) return false;
  const candidate = value as Partial<ForegroundBootAttempt>;
  return (
    Number.isSafeInteger(candidate.activationEpoch) &&
    candidate.activationEpoch! >= 0 &&
    isForegroundSessionSnapshot(candidate.snapshot) &&
    !!candidate.resources &&
    typeof candidate.resources === 'object' &&
    Object.prototype.hasOwnProperty.call(candidate.resources, 'db') &&
    (candidate.resources.db === null || typeof candidate.resources.db === 'object')
  );
}

function foregroundAttemptIsCurrent(
  attempt: Pick<ForegroundBootAttempt, 'activationEpoch'>,
  stageSignal: AbortSignal,
): boolean {
  return !stageSignal.aborted && attempt.activationEpoch === connectionAttemptEpoch;
}

function requireForegroundAttemptCurrent(
  attempt: Pick<ForegroundBootAttempt, 'activationEpoch'>,
  stageSignal: AbortSignal,
): void {
  if (!foregroundAttemptIsCurrent(attempt, stageSignal)) {
    throw new ForegroundBootSupersededError();
  }
}

function connectedForegroundAttempt(
  snapshot: ForegroundSessionSnapshot,
  activationEpoch: number,
): ForegroundBootAttempt {
  return Object.freeze({
    activationEpoch,
    snapshot,
    resources: { db: null },
  });
}

/** Put boot on the setup route without interpreting an I/O failure as permission to erase data. */
function quarantineSessionRestore(
  inspection: Extract<DurableSessionInspection, { kind: 'unavailable' }>,
): void {
  if (inspection.source === 'marker') {
    logger.warn('[boot] account revocation marker unreadable — session restore blocked');
  } else {
    logger.warn(
      '[boot] secure session state unreadable — session restore blocked',
      inspection.error,
    );
  }
  void pauseRealtimeDeliveries();
  const store = useSessionStore.getState();
  store.hydrated(null);
  store.failed(ACCOUNT_STATE_UNAVAILABLE_MESSAGE);
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
  db: AppDatabase,
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

/** Resolve the pre-DB/activation boot gate. A null result means boot must stop here. */
async function resolveBootSession(
  inspection: DurableSessionInspection,
): Promise<ForegroundSessionSnapshot | null> {
  if (inspection.kind === 'unavailable') {
    quarantineSessionRestore(inspection);
    return null;
  }
  if (inspection.kind === 'empty') {
    // A clean first launch should reach setup without opening a brand-new encrypted DB merely to
    // discover it has no session. Explicit connect performs the idempotent wipe, because an empty
    // vault alone cannot prove a legacy/broken cleanup did not leave account-scoped rows behind.
    void pauseRealtimeDeliveries();
    useSessionStore.getState().hydrated(null);
    return null;
  }
  if (inspection.kind === 'revoked' || inspection.kind === 'cleanup-required') {
    // A tombstone is written BEFORE the local wipe, so `forgotten` means "cleanup may have been
    // interrupted", not "cleanup is complete". Resume the whole idempotent wipe before any DB
    // hydration, search backfill, sync, or candidate connection can touch the old account.
    if (lastSuccessfulForgetEpoch === connectionAttemptEpoch) return null;
    const outcome = await runOrAwaitForget();
    if (!outcome.ok) {
      logger.warn('[boot] residual-account cleanup remains incomplete', outcome.error);
    }
    return null;
  }
  return inspection.session;
}

/** Inspect the durable account boundary for one coordinator-owned foreground run. */
export async function inspectForegroundBootSession(
  context: BootStageContext,
): Promise<BootSessionOutcome<ForegroundBootAttempt>> {
  const activationEpoch = connectionAttemptEpoch;
  const placeholder = { activationEpoch };

  // Public Disconnect starts its successor immediately so the root can show a bounded failure
  // instead of an endless idle spinner. The wipe is published before that restart, so join it
  // before reading either revocation marker or SecureStore; account A stays quarantined throughout.
  const cleanupAlreadyRunning = forgetInFlight;
  if (cleanupAlreadyRunning) {
    const outcome = await cleanupAlreadyRunning.outcome;
    if (context.stageSignal.aborted) throw new ForegroundBootSupersededError();
    if (!outcome.ok) {
      throw new ForegroundBootOperationalError(
        'residual-account-cleanup-failed',
        RESIDUAL_CLEANUP_FAILURE_MESSAGE,
        { cause: outcome.error },
      );
    }
    return { kind: 'setup' };
  }

  const inspection = await inspectDurableServerSession(vault, accountRevocationMarker);
  requireForegroundAttemptCurrent(placeholder, context.stageSignal);

  if (inspection.kind === 'unavailable') {
    if (inspection.source === 'marker') {
      logger.warn('[boot] account revocation marker unreadable — session restore blocked');
    } else {
      logger.warn(
        '[boot] secure session state unreadable — session restore blocked',
        inspection.error,
      );
    }
    await pauseRealtimeDeliveries();
    throw new ForegroundBootOperationalError(
      'durable-session-unavailable',
      ACCOUNT_STATE_UNAVAILABLE_MESSAGE,
      { cause: inspection.error },
    );
  }

  if (inspection.kind === 'empty') {
    await pauseRealtimeDeliveries();
    requireForegroundAttemptCurrent(placeholder, context.stageSignal);
    useSessionStore.getState().hydrated(null);
    return { kind: 'setup' };
  }

  if (inspection.kind === 'revoked' || inspection.kind === 'cleanup-required') {
    // The forget barrier has its own bounded drains and is single-flight. Do not abandon it merely
    // because the outer session stage deadline fired; a later retry must join the same cleanup.
    if (lastSuccessfulForgetEpoch === connectionAttemptEpoch) return { kind: 'setup' };
    const outcome = await runOrAwaitForget();
    // This cleanup intentionally advances connectionAttemptEpoch. Whole-run invalidation still
    // aborts stageSignal, while the cleanup-owned epoch change is allowed to reach setup.
    if (context.stageSignal.aborted) throw new ForegroundBootSupersededError();
    if (!outcome.ok) {
      throw new ForegroundBootOperationalError(
        'residual-account-cleanup-failed',
        RESIDUAL_CLEANUP_FAILURE_MESSAGE,
        { cause: outcome.error },
      );
    }
    return { kind: 'setup' };
  }

  return {
    kind: 'connected',
    session: connectedForegroundAttempt(inspection.session, activationEpoch),
  };
}

/** Open the encrypted database without publishing account UI state. */
export async function openForegroundBootDatabase(
  context: BootStageContext,
  attempt: ForegroundBootAttempt,
): Promise<void> {
  requireForegroundAttemptCurrent(attempt, context.stageSignal);
  let db: AppDatabase;
  try {
    db = await ensureDatabase();
  } catch (error) {
    logger.error('[db] initialization failed', 'syjo8z3ok4', error);
    throw new ForegroundBootOperationalError(
      'database-open-failed',
      DATABASE_BOOT_FAILURE_MESSAGE,
      { cause: error },
    );
  }
  requireForegroundAttemptCurrent(attempt, context.stageSignal);
  attempt.resources.db = db;
}

/** Hydrate every DB-backed preference under the exact run's late-commit guard. */
export async function hydrateForegroundBootSettings(
  context: BootStageContext,
  attempt: ForegroundBootAttempt,
): Promise<void> {
  requireForegroundAttemptCurrent(attempt, context.stageSignal);
  if (!attempt.resources.db) {
    throw new ForegroundBootOperationalError(
      'database-stage-output-missing',
      DATABASE_BOOT_FAILURE_MESSAGE,
    );
  }
  try {
    await hydrateAllStores({
      shouldCommit: () => foregroundAttemptIsCurrent(attempt, context.stageSignal),
      onError: (error) => logger.warn('[boot] settings hydration failed', error),
    });
  } catch (error) {
    if (!foregroundAttemptIsCurrent(attempt, context.stageSignal)) {
      throw new ForegroundBootSupersededError();
    }
    logger.warn('[boot] settings hydration registry failed', error);
    throw new ForegroundBootOperationalError(
      'settings-hydration-failed',
      SETTINGS_HYDRATION_FAILURE_MESSAGE,
      { cause: error },
    );
  }
  requireForegroundAttemptCurrent(attempt, context.stageSignal);
  if (!areCriticalSettingsHydrated()) {
    throw new ForegroundBootOperationalError(
      'critical-settings-unavailable',
      SETTINGS_HYDRATION_FAILURE_MESSAGE,
    );
  }
}

async function requireMatchingForegroundSession(
  context: BootStageContext,
  attempt: ForegroundBootAttempt,
): Promise<ForegroundSessionSnapshot> {
  const inspection = await inspectDurableServerSession(vault, accountRevocationMarker);
  requireForegroundAttemptCurrent(attempt, context.stageSignal);
  if (inspection.kind !== 'ready' || !sameForegroundSession(attempt.snapshot, inspection.session)) {
    throw new ForegroundBootOperationalError(
      'durable-session-changed',
      ACCOUNT_STATE_UNAVAILABLE_MESSAGE,
      { cause: inspection.kind === 'unavailable' ? inspection.error : undefined },
    );
  }
  return inspection.session;
}

async function recoverAttachmentCacheWithinDeadline(
  db: AppDatabase,
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
      userMessage: 'Downloaded attachments are temporarily unavailable until the next restart.',
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
      userMessage: 'Downloaded attachments are temporarily unavailable until the next restart.',
    });
  }
  return outcome;
}

/** Revalidate identity, reconcile cache ownership, then publish the one connected session. */
export async function activateForegroundBootSession(
  context: BootStageContext,
  attempt: ForegroundBootAttempt,
): Promise<void> {
  const db = attempt.resources.db;
  if (!db) {
    throw new ForegroundBootOperationalError(
      'database-stage-output-missing',
      DATABASE_BOOT_FAILURE_MESSAGE,
    );
  }
  await requireMatchingForegroundSession(context, attempt);
  requireForegroundAttemptCurrent(attempt, context.stageSignal);
  await requirePriorForegroundDeliveryDrain();
  requireForegroundAttemptCurrent(attempt, context.stageSignal);

  resumeRealtimeDeliveries();
  const deliveryLease = captureRealtimeDeliveryLease();
  context.registerDisposer(() => {
    if (!deliveryLease.isCurrent()) return;
    // Closing admission is synchronous. Account teardown owns the bounded drain; awaiting it here
    // would put the same potentially hung delivery into the coordinator's unbounded cleanup barrier.
    closeForegroundDeliveryAdmission();
  });
  const cacheRecovery = await recoverAttachmentCacheWithinDeadline(
    db,
    deliveryLease,
    () => foregroundAttemptIsCurrent(attempt, context.stageSignal),
    'boot',
    context.reportIssue,
  );
  if (cacheRecovery === 'stale') throw new ForegroundBootSupersededError();
  const activationSession = await requireMatchingForegroundSession(context, attempt);
  requireForegroundAttemptCurrent(attempt, context.stageSignal);

  const { sessionState, origin, password } = activationSession;
  if (!hasActiveServerSession(sessionState, origin, password)) {
    throw new ForegroundBootOperationalError(
      'durable-session-inactive',
      ACCOUNT_STATE_UNAVAILABLE_MESSAGE,
    );
  }

  // This synchronous commit is the single point where password-bearing state becomes live. Every
  // operation below is optional and guarded by the captured delivery generation.
  useSessionStore.getState().hydrated({ origin, password });

  void runSearchTextBackfillOnce(deliveryLease);
  const serverInfoLease = captureRealtimeDeliveryLease();
  void serverApi
    .serverInfo(http)
    .then((info) => {
      if (serverInfoLease.isCurrent()) useSessionStore.getState().setServerInfo(info);
    })
    .catch((error) => {
      if (serverInfoLease.isCurrent()) logger.debug('[boot] server-info refresh failed', error);
    });
  void startSync().catch((error) => {
    if (!deliveryLease.isCurrent()) return;
    logger.warn('[boot] initial sync failed to start', error);
    context.reportIssue({
      stage: 'sync',
      level: 'degraded',
      code: 'initial-sync-unavailable',
      userMessage: 'Messages may be out of date until sync retries.',
    });
  });
  void startRealtime({
    reportIssue: (issue) => {
      if (deliveryLease.isCurrent()) context.reportIssue(issue);
    },
  }).catch((error) => {
    if (!deliveryLease.isCurrent()) return;
    logger.warn('[boot] realtime startup failed', error);
    context.reportIssue({
      stage: 'realtime',
      level: 'degraded',
      code: 'realtime-unavailable',
      userMessage: 'Live updates are unavailable; pull to refresh while Gator retries.',
    });
  });
}

/** Load stored credentials from the vault at boot and resolve the initial route. */
export async function hydrateSession(): Promise<void> {
  // Capture before the first await. A Disconnect that starts during any durable-session or DB read
  // owns the result, even if this run happened to read the old active tuple first.
  const activationEpoch = connectionAttemptEpoch;
  const isActivationCurrent = (): boolean => activationEpoch === connectionAttemptEpoch;
  const store = useSessionStore.getState();
  const preDbSession = await resolveBootSession(
    await inspectDurableServerSession(vault, accountRevocationMarker),
  );
  if (!preDbSession || !isActivationCurrent()) return;

  // Open the encrypted store first so cached data is available offline. A
  // failure must not activate UI/sync/realtime with unhydrated settings defaults.
  let db: AppDatabase;
  try {
    db = await ensureDatabase();
  } catch (e: unknown) {
    logger.error('[db] initialization failed', 'solmtuzd5x', e);
    if (isActivationCurrent()) {
      void pauseRealtimeDeliveries();
      store.failed(SETTINGS_HYDRATION_FAILURE_MESSAGE);
    }
    return;
  }
  if (!isActivationCurrent()) return;
  // FIRST point the kv store is readable: every store's `hydrate()` calls `getDatabase()`, which
  // THROWS until the DB is open, so the root layout's pre-boot pass always no-ops on a cold launch
  // and the settings stay at their module defaults until the home screen's re-hydrate. Awaited
  // HERE because `runSync` reads `messagesPerChat` and `void startSync()` is fired below — without
  // this, a user who chose 25/chat silently got the default 100 on the first sync after every
  // relaunch. Theme remains a safe-dark, never-blank fallback; the critical settings below are
  // activation requirements because their defaults are not authoritative persisted choices.
  try {
    await hydrateAllStores({
      shouldCommit: isActivationCurrent,
      onError: (error) => logger.warn('[boot] settings hydration failed', error),
    });
  } catch (error) {
    // Stores currently contain their own expected DB/read failures. Keep this outer boundary for a
    // future store regression so boot still publishes a recoverable, fail-closed state.
    if (!isActivationCurrent()) return;
    logger.warn('[boot] settings hydration registry failed', error);
    void pauseRealtimeDeliveries();
    store.failed(SETTINGS_HYDRATION_FAILURE_MESSAGE);
    return;
  }
  if (!isActivationCurrent()) return;
  if (!areCriticalSettingsHydrated()) {
    void pauseRealtimeDeliveries();
    store.failed(SETTINGS_HYDRATION_FAILURE_MESSAGE);
    return;
  }

  // Reinspect after the DB/store awaits, immediately before admitting any backfill, sync, socket,
  // or server-info work. If Disconnect raced boot, its marker/tombstone wins and the wipe resumes.
  const activationSession = await resolveBootSession(
    await inspectDurableServerSession(vault, accountRevocationMarker),
  );
  if (!activationSession || !isActivationCurrent()) return;
  if (!sameForegroundSession(preDbSession, activationSession)) {
    void pauseRealtimeDeliveries();
    store.failed(ACCOUNT_STATE_UNAVAILABLE_MESSAGE);
    return;
  }
  const { sessionState, origin, password } = activationSession;
  if (hasActiveServerSession(sessionState, origin, password) && origin && password) {
    resumeRealtimeDeliveries();
    const cacheLease = captureRealtimeDeliveryLease();
    const cacheRecovery = await recoverAttachmentCacheForActivation(db, cacheLease, 'boot');
    if (cacheRecovery === 'stale' || !cacheLease.isCurrent() || !isActivationCurrent()) {
      return;
    }
    store.hydrated({ origin, password });
    // Make older edited/SMS messages searchable only after BOTH durable session gates authorize
    // this account. A revoked restart must run its residual wipe without this stale writer racing.
    void runSearchTextBackfillOnce(cacheLease);
    // `hydrated` restores creds but NOT serverInfo (only first-setup `connect` sets it), so
    // Settings' Version/macOS/Private-API rows stayed blank on every relaunch. Re-fetch it in
    // the background so those screens populate — best-effort, never blocks boot.
    const serverInfoLease = captureRealtimeDeliveryLease();
    void serverApi
      .serverInfo(http)
      .then((info) => {
        if (serverInfoLease.isCurrent()) useSessionStore.getState().setServerInfo(info);
      })
      .catch((e) => {
        if (serverInfoLease.isCurrent()) logger.debug('[boot] server-info refresh failed', e);
      });
    void startSync();
    void startRealtime();
  } else {
    // Close this live JS context too. A future killed-app context starts open but independently
    // fails the vault session gate; a successful explicit connection reopens admission below.
    void pauseRealtimeDeliveries();
    store.hydrated(null);
  }
}

/** Only one candidate may validate and commit the four-part SecureStore tuple at a time. */
let connectInFlight = false;

function unavailableConnectionMessage(
  inspection: Extract<DurableSessionInspection, { kind: 'unavailable' }>,
): string {
  if (inspection.source === 'marker') {
    logger.warn('[connect] account revocation marker unreadable — candidate blocked');
  } else {
    logger.warn('[connect] secure session state unreadable — candidate blocked', inspection.error);
  }
  return ACCOUNT_STATE_UNAVAILABLE_MESSAGE;
}

export function disconnectFailureMessage(error: unknown): string {
  return error instanceof Error && error.message === CREDENTIAL_REMOVAL_FAILURE_MESSAGE
    ? error.message
    : RESIDUAL_CLEANUP_FAILURE_MESSAGE;
}

const CANDIDATE_GATE_CANCELLED = Symbol('candidate-gate-cancelled');

/**
 * Recheck durable account state immediately before validating a candidate server.
 *
 * A retained active tuple may only be recovered with the exact same normalized origin/password.
 * Silently replacing it with account B would retain account A's encrypted DB. A different account
 * must therefore restore A, use the explicit Disconnect flow, and let that confirmed wipe finish.
 */
async function prepareCandidateConnection(
  origin: string,
  password: string,
  cleanupAlreadyCompleted: boolean,
  isAuthorized: () => boolean,
): Promise<string | null | typeof CANDIDATE_GATE_CANCELLED> {
  const inspection = await inspectDurableServerSession(vault, accountRevocationMarker);
  if (!isAuthorized()) return CANDIDATE_GATE_CANCELLED;
  if (inspection.kind === 'unavailable') return unavailableConnectionMessage(inspection);

  if (
    inspection.kind === 'empty' ||
    inspection.kind === 'revoked' ||
    inspection.kind === 'cleanup-required'
  ) {
    if (!cleanupAlreadyCompleted && lastSuccessfulForgetEpoch !== connectionAttemptEpoch) {
      // This is the only mutating branch. A deadline must revoke it before a delayed vault read
      // can wake and wipe a newer connection attempt.
      if (!isAuthorized()) return CANDIDATE_GATE_CANCELLED;
      const cleanup = await runOrAwaitForget();
      if (!isAuthorized()) return CANDIDATE_GATE_CANCELLED;
      if (!cleanup.ok) return disconnectFailureMessage(cleanup.error);
      // The marker/tombstone deliberately remains until the candidate credential commit completes.
      // Reinspect only to prove the durable state is still readable before making a network call.
      return prepareCandidateConnection(origin, password, true, isAuthorized);
    }
    return null;
  }

  const saved = inspection.session;
  if (hasActiveServerSession(saved.sessionState, saved.origin, saved.password)) {
    const savedOrigin = saved.origin ? sanitizeServerAddress(saved.origin) : null;
    if (savedOrigin !== origin || saved.password !== password) {
      return DIFFERENT_SAVED_ACCOUNT_MESSAGE;
    }
  }
  return null;
}

/**
 * Validate + connect to a server, updating the session store with the outcome.
 *
 * `allowCleartext` must be explicitly set true to connect to a plaintext `http://` origin
 * (e.g. a LAN/IP server the user knowingly trusts). By default we reject it: we must never
 * attach the Bearer credential to an unencrypted origin without that acknowledgement. Android's
 * generated manifest permits cleartext for explicitly approved LAN compatibility, so this
 * application-level decision is the credential-safety gate.
 */
export async function connect(
  rawOrigin: string,
  password: string,
  allowCleartext = false,
): Promise<void> {
  const store = useSessionStore.getState();
  if (connectInFlight) {
    // Do not let a rapid second QR/button event interleave `writing -> address -> password -> active`
    // with the first. The screen is already showing the first attempt's Connecting state.
    logger.warn('[connect] ignored a concurrent connection attempt');
    return;
  }
  const origin = sanitizeServerAddress(rawOrigin);
  if (!origin) {
    store.failed('Please enter a valid server URL.');
    return;
  }
  if (isCleartext(origin) && !allowCleartext) {
    store.failed(
      'This server uses an insecure http:// connection. Use https://, or enable insecure connections to continue.',
    );
    return;
  }
  if (!password) {
    store.failed('Please enter your server password.');
    return;
  }

  // Claim synchronously, before the first await. UI button disabling happens from this same state,
  // but two events can enter this function before React has rendered that disabled prop.
  connectInFlight = true;
  let attemptAuthorized = true;
  let connectionCommitted = false;
  const revokeAttempt = (): void => {
    attemptAuthorized = false;
  };
  activeConnectRevoker = revokeAttempt;
  try {
    store.beginConnecting();
    if (accountCleanupQuarantine) {
      store.failed(ACCOUNT_CLEANUP_QUARANTINE_MESSAGE);
      return;
    }
    if (connectCandidateQuarantine) {
      store.failed(CONNECT_CANDIDATE_QUARANTINE_MESSAGE);
      return;
    }
    if (connectDatabaseQuarantine) {
      store.failed(CONNECT_DATABASE_QUARANTINE_MESSAGE);
      return;
    }
    // A Disconnect navigates away the moment the session resets, but its wipe keeps running behind
    // the setup screen. Connecting on top of that would let its DB delete race the new server's sync.
    const priorCleanupResult = await settleWithinDeadline(
      awaitForgetIdle(),
      CONNECT_ACCOUNT_GATE_DEADLINE_MS,
    );
    if (priorCleanupResult.kind === 'timeout') {
      store.failed(CONNECT_GATE_TIMEOUT_MESSAGE);
      return;
    }
    if (priorCleanupResult.kind === 'error') {
      store.failed(RESIDUAL_CLEANUP_FAILURE_MESSAGE);
      return;
    }
    const priorCleanup = priorCleanupResult.value;
    if (priorCleanup && !priorCleanup.ok) {
      store.failed(disconnectFailureMessage(priorCleanup.error));
      return;
    }

    let cleanupAlreadyCompleted = priorCleanup?.ok === true;
    let attemptEpoch: number;
    while (true) {
      const gateOperation = prepareCandidateConnection(
        origin,
        password,
        cleanupAlreadyCompleted,
        () => attemptAuthorized,
      );
      const gateResult = await settleWithinDeadline(
        gateOperation,
        CONNECT_ACCOUNT_GATE_DEADLINE_MS,
        () => {
          attemptAuthorized = false;
        },
      );
      if (gateResult.kind === 'timeout') {
        store.failed(CONNECT_GATE_TIMEOUT_MESSAGE);
        return;
      }
      if (gateResult.kind === 'error') {
        store.failed(RESIDUAL_CLEANUP_FAILURE_MESSAGE);
        return;
      }
      const gateFailure = gateResult.value;
      if (gateFailure === CANDIDATE_GATE_CANCELLED) return;
      if (gateFailure) {
        store.failed(gateFailure);
        return;
      }

      // A second/public Disconnect may have started while the final marker/SecureStore inspection
      // was suspended. Join it and re-run the durable gate. Only capture the candidate epoch in the
      // same synchronous turn that proves no wipe is published; a later forget increments it.
      const overlappingCleanup = forgetInFlight;
      if (!overlappingCleanup) {
        attemptEpoch = connectionAttemptEpoch;
        break;
      }
      const overlappingResult = await settleWithinDeadline(
        overlappingCleanup.outcome,
        CONNECT_ACCOUNT_GATE_DEADLINE_MS,
      );
      if (overlappingResult.kind === 'timeout') {
        store.failed(CONNECT_GATE_TIMEOUT_MESSAGE);
        return;
      }
      if (overlappingResult.kind === 'error') {
        store.failed(RESIDUAL_CLEANUP_FAILURE_MESSAGE);
        return;
      }
      const overlappingOutcome = overlappingResult.value;
      if (!overlappingOutcome.ok) {
        store.failed(disconnectFailureMessage(overlappingOutcome.error));
        return;
      }
      cleanupAlreadyCompleted = true;
    }

    // A residual wipe resets session UI synchronously. Put this attempt back into Connecting only
    // after that wipe has finished and immediately before candidate validation begins.
    store.beginConnecting();
    const isAttemptCurrent = (): boolean =>
      attemptAuthorized && attemptEpoch === connectionAttemptEpoch;
    const client = candidateClient(origin, password);
    const candidateOperation = connectToServer(origin, password, {
      fetchServerInfo: () => serverApi.serverInfo(client),
      vault,
      revocationMarker: accountRevocationMarker,
      isAttemptCurrent,
    });
    const candidateResult = await settleWithinDeadline(
      candidateOperation,
      CONNECT_CANDIDATE_DEADLINE_MS,
      () => {
        attemptAuthorized = false;
        quarantineConnectCandidate(candidateOperation);
      },
    );
    if (candidateResult.kind === 'timeout') {
      store.failed(CONNECT_CANDIDATE_TIMEOUT_MESSAGE);
      return;
    }
    if (candidateResult.kind === 'error') {
      attemptAuthorized = false;
      logger.warn('[connect] candidate validation failed unexpectedly', candidateResult.error);
      store.failed('Unexpected error while connecting.');
      return;
    }
    const result = candidateResult.value;

    // Disconnect can invalidate the attempt in the microtask gap after candidate validation or a
    // final vault write. It has already reset the store and marked the account revoked; do not
    // overwrite that authoritative state with either Connected or a stale candidate error.
    if (!isAttemptCurrent() || (!result.ok && result.kind === 'cancelled')) return;
    if (result.ok) {
      // A validated server is not enough to expose cached UI or start sync/socket work. On a fresh
      // process the kv-backed settings stores are still at module defaults until the encrypted DB is
      // open. Restore them under this candidate's ownership first; Disconnect invalidates the guard.
      let db: AppDatabase;
      const databaseOperation = ensureDatabase();
      const databaseResult = await settleWithinDeadline(
        databaseOperation,
        CONNECT_DATABASE_DEADLINE_MS,
        () => {
          attemptAuthorized = false;
          quarantineConnectDatabase(databaseOperation);
        },
      );
      if (databaseResult.kind === 'timeout') {
        void pauseRealtimeDeliveries();
        store.failed(CONNECT_DATABASE_TIMEOUT_MESSAGE);
        return;
      }
      if (databaseResult.kind === 'error') {
        logger.error(
          '[connect] database initialization failed',
          'skjyhvynmb',
          databaseResult.error,
        );
        if (isAttemptCurrent()) {
          void pauseRealtimeDeliveries();
          store.failed(SETTINGS_HYDRATION_FAILURE_MESSAGE);
        }
        return;
      }
      db = databaseResult.value;
      if (!isAttemptCurrent()) return;
      const settingsResult = await settleWithinDeadline(
        hydrateAllStores({
          shouldCommit: isAttemptCurrent,
          onError: (error) => logger.warn('[connect] settings hydration failed', error),
        }),
        CONNECT_SETTINGS_DEADLINE_MS,
        () => {
          attemptAuthorized = false;
        },
      );
      if (settingsResult.kind === 'timeout') {
        void pauseRealtimeDeliveries();
        store.failed(`${SETTINGS_HYDRATION_FAILURE_MESSAGE} Settings loading took too long.`);
        return;
      }
      if (settingsResult.kind === 'error') {
        if (!isAttemptCurrent()) return;
        logger.warn('[connect] settings hydration registry failed', settingsResult.error);
        void pauseRealtimeDeliveries();
        store.failed(SETTINGS_HYDRATION_FAILURE_MESSAGE);
        return;
      }
      if (!isAttemptCurrent()) return;
      if (!areCriticalSettingsHydrated()) {
        void pauseRealtimeDeliveries();
        store.failed(SETTINGS_HYDRATION_FAILURE_MESSAGE);
        return;
      }
      resumeRealtimeDeliveries();
      const cacheLease = captureRealtimeDeliveryLease();
      const reportConnectIssue = (issue: BootIssue): void => {
        if (cacheLease.isCurrent() && isAttemptCurrent()) reportForegroundBootIssue(issue);
      };
      const cacheRecovery = await recoverAttachmentCacheWithinDeadline(
        db,
        cacheLease,
        isAttemptCurrent,
        'connect',
        reportConnectIssue,
      );
      if (cacheRecovery === 'stale' || !cacheLease.isCurrent() || !isAttemptCurrent()) return;
      store.connected(origin, password, result.serverInfo);
      connectionCommitted = true;
      void startSync().catch((error) => {
        if (!cacheLease.isCurrent()) return;
        logger.warn('[connect] initial sync failed to start', error);
        reportConnectIssue({
          stage: 'sync',
          level: 'degraded',
          code: 'initial-sync-unavailable',
          userMessage: 'Messages may be out of date until sync retries.',
        });
      });
      void startRealtime({ reportIssue: reportConnectIssue }).catch((error) => {
        if (!cacheLease.isCurrent()) return;
        logger.warn('[connect] realtime startup failed', error);
        reportConnectIssue({
          stage: 'realtime',
          level: 'degraded',
          code: 'realtime-unavailable',
          userMessage: 'Live updates are unavailable; pull to refresh while Gator retries.',
        });
      });
    } else {
      store.failed(result.message);
    }
  } finally {
    // Successful optional work keeps reporting through this exact epoch/lease after `connect`
    // returns. Disconnect revokes both; every unsuccessful attempt is revoked here immediately.
    if (!connectionCommitted) attemptAuthorized = false;
    if (activeConnectRevoker === revokeAttempt) activeConnectRevoker = null;
    connectInFlight = false;
  }
}

/**
 * Retire the correlated SecureStore tuple monotonically: tombstone, deletes, then empty-overwrite
 * fallback. The independent marker decides whether the caller may bound this chain safely.
 */
async function retireDurableCredentials(independentlyRevoked: boolean): Promise<Error | null> {
  let tombstoneWritten = false;
  try {
    await vault.set('serverSessionState', SERVER_SESSION_STATE.forgotten);
    tombstoneWritten = true;
  } catch (error) {
    logger.warn('[forget] session tombstone write failed', error);
  }

  const cleared = await Promise.allSettled([
    vault.delete('serverAddress'),
    vault.delete('serverPassword'),
  ]);
  for (const outcome of cleared) {
    if (outcome.status === 'rejected') {
      logger.warn('[forget] credential delete failed — it is still in the vault', outcome.reason);
    }
  }

  // Without either the tombstone or one successful delete, use a different native operation to
  // disable the pair. Active sessions require BOTH credentials to be non-empty.
  if (!tombstoneWritten && cleared.every((outcome) => outcome.status === 'rejected')) {
    const overwritten = await Promise.allSettled([
      vault.set('serverAddress', ''),
      vault.set('serverPassword', ''),
    ]);
    for (const outcome of overwritten) {
      if (outcome.status === 'rejected') {
        logger.warn('[forget] empty credential overwrite fallback failed', outcome.reason);
      }
    }
    if (!independentlyRevoked && overwritten.every((outcome) => outcome.status === 'rejected')) {
      const failure = new Error(CREDENTIAL_REMOVAL_FAILURE_MESSAGE);
      logger.warn(`[forget] ${CREDENTIAL_REMOVAL_FAILURE_MESSAGE} Local wipe will continue.`);
      return failure;
    }
  }
  return null;
}

interface DatabaseAccountCleanupResult {
  readonly databaseFailure: Error | null;
  readonly notificationFailure: Error | null;
}

/** One hazardous DB chain: open, retire reminder alarms, then wipe and confirm old-account rows. */
async function cleanupAccountDatabase(): Promise<DatabaseAccountCleanupResult> {
  let notificationFailure: Error | null = null;
  try {
    const db = await ensureDatabase();
    try {
      const pending = await listReminders(db);
      if (pending.length > 0) {
        const { cancelReminderNotification } = await import('./notifications/notifeeService');
        let reminderCleanupRejected = false;
        const reminderCleanup = Promise.allSettled(
          pending.map((reminder) => cancelReminderNotification(reminder.notificationId)),
        ).then((outcomes) => {
          const rejection = outcomes.find((outcome) => outcome.status === 'rejected');
          if (rejection?.status === 'rejected') {
            reminderCleanupRejected = true;
            logger.warn('[forget] reminder cancel failed', rejection.reason);
          }
        });
        const reminderCleanupCompleted = await withDeadline(
          reminderCleanup,
          NOTIFICATION_CLEAR_DEADLINE_MS,
        );
        if (!reminderCleanupCompleted) {
          logger.warn('[forget] reminder cleanup timed out — trigger removal remains unconfirmed');
        }
        if (!reminderCleanupCompleted || reminderCleanupRejected) {
          notificationFailure = new Error(NOTIFICATION_CLEANUP_FAILURE_MESSAGE);
        }
      }
    } catch (error) {
      notificationFailure = new Error(NOTIFICATION_CLEANUP_FAILURE_MESSAGE);
      logger.warn('[forget] reminder cancel failed', error);
    }
    return {
      databaseFailure: (await wipeLocalCache(db))
        ? null
        : new Error(DATABASE_CLEANUP_FAILURE_MESSAGE),
      notificationFailure,
    };
  } catch (error) {
    // warn, not error: this runs while disconnecting, and an `error` line would be queued for
    // upload to the very server we are leaving.
    logger.warn('[forget] local cache wipe could not run', error);
    return {
      databaseFailure: new Error(DATABASE_CLEANUP_FAILURE_MESSAGE),
      notificationFailure,
    };
  }
}

/**
 * Forget the connection: clear the credentials, reset the session, and destroy everything this
 * device holds for that server — cached rows (`clearLocalCache`), the reminders' OS alarms, the
 * Direct Share chips, and the downloaded media on disk. The order matters and is explained inline.
 * Every cleanup surface is attempted even if an earlier one fails. A failure leaves the durable
 * revocation gates closed and rejects the run, so a new connection cannot inherit unconfirmed old
 * account state and will retry the whole idempotent cleanup first.
 *
 * Exported through the {@link forget} wrapper, which publishes the run so `connect()` can wait for
 * it — the session reset happens early, so the user is already back on the setup screen while this
 * is still deleting.
 */
async function runForget(invalidateForegroundBoot: boolean): Promise<void> {
  // FIRST instruction: revoke a candidate suspended in server validation or SecureStore. The
  // connection layer checks this epoch after every await and before clearing the durable marker;
  // bootstrap checks it again before publishing Connected/starting account work.
  connectionAttemptEpoch += 1;
  const forgetEpoch = connectionAttemptEpoch;
  if (invalidateForegroundBoot) invalidateForegroundBootForAccountTransition();
  invalidateAttachmentCacheRecoveryReadiness();
  // Close admission before the first await, then drain anything admitted just before the tap.
  // Realtime DB writes and native presentation are short tracked commits. Long downloads carry
  // the revoked generation outside this drain and must discard their eventual file/DB commit.
  const realtimeIdle = pauseRealtimeDeliveries();
  // Persist the independent, non-secret filesystem marker before invoking any UI/store/native
  // observer that could throw. Its native implementation uses a
  // synchronous app-private file operation: the attempt happens before the first vault mutation,
  // cannot wait on an unbounded promise, and remains readable when Android Keystore/SecureStore is
  // completely unavailable. A failure is recorded but never skips the local cleanup below.
  let independentlyRevoked = false;
  try {
    accountRevocationMarker.markRevoked();
    independentlyRevoked = true;
  } catch (e) {
    logger.warn('[forget] independent account revocation marker write failed', e);
  }

  // A Zustand subscriber or native teardown callback is application code and can throw
  // synchronously. Isolate every volatile step so one broken observer cannot skip session
  // revocation, socket retirement, or the durable cleanup below. Any such failure still blocks B;
  // a later retry performs the whole idempotent sweep again in a fresh/unmounted UI context.
  const failedInMemorySurfaces: string[] = [];
  try {
    uploadRegistry.cancelAll();
  } catch {
    failedInMemorySurfaces.push('upload-registry');
  }
  let errorReportsIdle = Promise.resolve();
  try {
    const resetResult = resetSessionScopedState();
    errorReportsIdle = resetResult.errorReportsIdle;
    failedInMemorySurfaces.push(...resetResult.failedSurfaces);
  } catch {
    // The coordinator isolates every registered adapter. Keep this outer boundary so a future
    // regression in its own orchestration still cannot abort Disconnect.
    failedInMemorySurfaces.push('session-reset-coordinator');
  }
  // Revoke live HTTP/socket credential reads synchronously too. SecureStore may hang or reject;
  // neither can be allowed to keep the old account authorized in this JS context.
  try {
    useSessionStore.getState().reset();
  } catch {
    failedInMemorySurfaces.push('session-store');
  }
  try {
    stopReachabilityWatch();
  } catch {
    failedInMemorySurfaces.push('reachability-watch');
  }
  try {
    stopDeviceNetworkWatch();
  } catch {
    failedInMemorySurfaces.push('network-watch');
  }
  let retiringSocket: ReturnType<typeof getSocket> = null;
  try {
    retiringSocket = getSocket();
  } catch {
    failedInMemorySurfaces.push('socket-reference');
  }
  try {
    retiringSocket?.disconnect();
  } catch {
    failedInMemorySurfaces.push('socket-disconnect');
  }
  try {
    setSocket(null);
  } catch {
    failedInMemorySurfaces.push('realtime-runtime');
  }
  const inMemoryCleanupFailure =
    failedInMemorySurfaces.length > 0 ? new Error(IN_MEMORY_CLEANUP_FAILURE_MESSAGE) : null;
  if (inMemoryCleanupFailure) {
    try {
      logger.warn('[forget] in-memory account cleanup steps failed', {
        surfaces: failedInMemorySurfaces,
      });
    } catch {
      // Logging is best-effort at this boundary; cleanup remains authoritative.
    }
  }
  // Close the authorization window BEFORE the wipe, not after. A sync started at boot can still be
  // paging when the user taps Disconnect, and nothing cancels it — with the credentials still in
  // place its remaining requests stay fully authorized, so `upsertChats`/`upsertMessages` land
  // AFTER the deletes and `fullSync` then writes a non-null marker. Clearing the origin first makes
  // every in-flight request fail immediately (a reset origin builds a relative URL), so the run
  // unwinds in seconds instead of minutes, and it means a Disconnect is honoured even if
  // everything below throws.

  // A previous timed-out destructive chain may still be deleting credentials, a Firebase token,
  // or DB rows. Do not pile another sweep on top of it. The first run already continued all other
  // cleanup; after this exact chain settles, a later run repeats the complete idempotent sweep.
  const priorCleanupQuarantine = accountCleanupQuarantine;
  if (
    priorCleanupQuarantine &&
    !(await withDeadline(priorCleanupQuarantine, ACCOUNT_CLEANUP_JOIN_DEADLINE_MS))
  ) {
    logger.warn('[forget] previous account cleanup operation is still settling');
    throw new Error(ACCOUNT_CLEANUP_QUARANTINE_FAILURE_MESSAGE);
  }

  // A timed-out candidate can have one already-issued SecureStore mutation still in native code.
  // Wait before this sweep so it cannot land behind our deletes. If it misses the bound, keep the
  // marker closed, finish the best-effort wipe, and reject so a later cleanup repeats after it stops.
  const candidateQuarantine = connectCandidateQuarantine;
  const candidateDrained =
    !candidateQuarantine ||
    (await withDeadline(candidateQuarantine, FOREGROUND_DELIVERY_CLEANUP_DEADLINE_MS));
  const candidateDrainFailure = candidateDrained
    ? null
    : new Error(CONNECT_CANDIDATE_DRAIN_FAILURE_MESSAGE);
  if (!candidateDrained) {
    logger.warn('[forget] timed-out connection candidate is still settling');
  }

  // SecureStore has no multi-key transaction. When the independent marker succeeded, this entire
  // monotonic retirement chain may be bounded: a late delete cannot reactivate A, and quarantine
  // prevents B until it settles plus a fresh full sweep passes. If the marker failed, never race a
  // timer—the vault chain is the only killed-process revocation proof and must remain awaited.
  const credentialRetirement = retireDurableCredentials(independentlyRevoked);
  let durableCredentialFailure: Error | null;
  if (independentlyRevoked) {
    const retirement = await settleWithinDeadline(
      credentialRetirement,
      CREDENTIAL_CLEANUP_DEADLINE_MS,
      () => quarantineAccountCleanup(credentialRetirement),
    );
    if (retirement.kind === 'value') {
      durableCredentialFailure = retirement.value;
    } else {
      durableCredentialFailure = new Error(CREDENTIAL_CLEANUP_TIMEOUT_MESSAGE);
      if (retirement.kind === 'timeout') {
        logger.warn('[forget] secure credential retirement timed out');
      } else {
        logger.warn('[forget] secure credential retirement failed unexpectedly', retirement.error);
      }
    }
  } else {
    durableCredentialFailure = await credentialRetirement;
  }

  // Firebase registration belongs to the OLD server even though the token itself lives in the
  // Firebase installation, not our DB/vault. Invalidating the installation token makes the token A
  // knows unusable; server-side removal may still be added later as defense in depth. Do this after
  // both durable revocation gates are closed, and treat native/import failure as incomplete account
  // cleanup: the local wipe continues, but connect B cannot validate until a retry succeeds.
  let fcmTokenRetirementFailure: Error | null = null;
  if (FCM_ENABLED) {
    const retirement = (async (): Promise<void> => {
      const { deleteToken, getMessaging } = await import('@react-native-firebase/messaging');
      await deleteToken(getMessaging());
    })();
    const result = await settleWithinDeadline(retirement, FCM_TOKEN_RETIREMENT_DEADLINE_MS, () =>
      quarantineAccountCleanup(retirement),
    );
    if (result.kind !== 'value') {
      fcmTokenRetirementFailure = new Error(FCM_TOKEN_RETIREMENT_FAILURE_MESSAGE);
      if (result.kind === 'timeout') {
        logger.warn('[forget] previous FCM token retirement timed out');
      } else {
        logger.warn('[forget] previous FCM token retirement failed', result.error);
      }
    }
  }
  const realtimeDrained = await withDeadline(realtimeIdle, REALTIME_DRAIN_DEADLINE_MS);
  const realtimeDrainFailure = realtimeDrained ? null : new Error(REALTIME_DRAIN_FAILURE_MESSAGE);
  if (!realtimeDrained) {
    // Admission/generation was invalidated synchronously, but the tracked set now includes whole
    // account actions and scheduled sends that can carry network/DB work. Still perform the sweep;
    // do not authorize B until a later retry proves every old slot idle and wipes once more.
    logger.warn('[forget] realtime delivery drain timed out — next connection remains blocked');
  }
  // An admitted send can reach its uploader after the first synchronous sweep. Re-cancel after the
  // account-work barrier, then join exact native tails that outlive their already-rejected public
  // send promise. A timeout leaves those terminal promises registered so the next cleanup retry
  // still blocks B until they settle.
  let uploadsDrained = false;
  try {
    uploadRegistry.cancelAll();
    uploadsDrained = await withDeadline(uploadRegistry.awaitIdle(), UPLOAD_DRAIN_DEADLINE_MS);
  } catch (error) {
    logger.warn('[forget] upload cancellation failed', error);
  }
  const uploadDrainFailure = uploadsDrained ? null : new Error(UPLOAD_DRAIN_FAILURE_MESSAGE);
  if (!uploadsDrained) {
    logger.warn('[forget] upload drain timed out — next connection remains blocked');
  }
  // …then let that dying run actually finish before we delete anything. Bounded: if a request is
  // wedged we still owe the user the wipe, and by now it can't fetch anything new anyway.
  const syncDrained = await withDeadline(awaitSyncIdle(), SYNC_DRAIN_DEADLINE_MS);
  const syncDrainFailure = syncDrained ? null : new Error(SYNC_DRAIN_FAILURE_MESSAGE);
  if (!syncDrained) {
    // HttpClient snapshots A's transport for an in-flight request. Until every sync page commit is
    // generation-guarded, a late response may repopulate A rows after this sweep; keep B blocked so
    // a later cleanup can drain that run and wipe again.
    logger.warn('[forget] sync drain timed out — next connection remains blocked');
  }
  let downloadsDrained = false;
  try {
    const { cancelAndDrainBoundedDownloads } = await import('./download/boundedNativeDownload');
    downloadsDrained = await cancelAndDrainBoundedDownloads(DOWNLOAD_DRAIN_DEADLINE_MS);
  } catch (error) {
    logger.warn('[forget] bounded-download cancellation failed', error);
  }
  const downloadDrainFailure = downloadsDrained ? null : new Error(DOWNLOAD_DRAIN_FAILURE_MESSAGE);
  if (!downloadsDrained) {
    logger.warn('[forget] bounded-download drain timed out — next connection remains blocked');
  }
  if (!(await withDeadline(errorReportsIdle, ERROR_REPORT_DRAIN_DEADLINE_MS))) {
    // The old drain's generation is already revoked. Its DB transaction either rolls back or is
    // ordered ahead of the wipe on the shared write queue, so a timeout cannot repopulate the
    // cleared table; it only means Disconnect stops waiting for the diagnostic task itself.
    logger.warn('[forget] error-report drain timed out — continuing with generation revoked');
  }

  // Pull the previous account's notifications out of the tray. A DISPLAYED notification is system
  // state that outlives every row this function is about to delete, and message notifications carry
  // the sender's name, avatar and message body — so without this the wipe destroys the local copy
  // while whoever picks the device up next still reads the content on the lock screen, and the
  // Disconnect dialog has just promised the opposite. Tapping one after reconnecting is worse than
  // useless too: a 1:1 guid is `service;-;address`, byte-identical across servers, so it opens the
  // NEW account's thread with that person (or an empty screen for a chat that does not exist here).
  //
  // cancelAllNotifications rather than a per-chat loop: everything this app has posted belongs to
  // the account being left, and enumerating them would need the DB — which is exactly what may be
  // unavailable. Ahead of the DB block for the same reason, with its own lazy import (notify-kit's
  // native bridge is deliberately kept out of this module's load graph) and its own try/catch. A
  // failure cannot skip the remaining cleanup, but it does keep the next account blocked.
  let notificationCleanupFailure: Error | null = null;
  try {
    const { cancelAllNotifications } = await import('./notifications/notifeeService');
    // Keep the queue ordering: if an older notification mutation is still finishing, this cleanup
    // must remain behind it and ahead of any future account's posts. But a native call can wedge
    // indefinitely, so attach the rejection handler now (preventing a late unhandled rejection)
    // and let the local account wipe continue after a bounded wait.
    let notificationCleanupRejected = false;
    const notificationCleanup = cancelAllNotifications().catch((e: unknown) => {
      notificationCleanupRejected = true;
      logger.warn('[forget] could not clear displayed notifications', e);
    });
    const notificationCleanupCompleted = await withDeadline(
      notificationCleanup,
      NOTIFICATION_CLEAR_DEADLINE_MS,
    );
    if (!notificationCleanupCompleted) {
      logger.warn(
        '[forget] notification cleanup timed out — continuing; queued cleanup remains ordered',
      );
    }
    if (!notificationCleanupCompleted || notificationCleanupRejected) {
      notificationCleanupFailure = new Error(NOTIFICATION_CLEANUP_FAILURE_MESSAGE);
    }
  } catch (e) {
    notificationCleanupFailure = new Error(NOTIFICATION_CLEANUP_FAILURE_MESSAGE);
    logger.warn('[forget] could not clear displayed notifications', e);
  }

  // Wipe everything the DB cached FROM this server. Clearing the credentials alone leaves the
  // whole local store intact, so connecting to a DIFFERENT server next shows the previous
  // account's threads interleaved with the new ones — on a shared device, someone else's
  // conversations — and the surviving sync marker sends the next sync down the incremental
  // branch with the OLD server's ROWID cursor. Unconditional: `applyNewServerUrl` legitimately
  // rewrites the origin for the SAME server on a tunnel rotation, so "did the origin change?"
  // is not a usable test. Failure cannot skip later cleanup, but it leaves the account quarantined.
  const databaseCleanup = cleanupAccountDatabase();
  const databaseResult = await settleWithinDeadline(
    databaseCleanup,
    DATABASE_CLEANUP_DEADLINE_MS,
    () => quarantineAccountCleanup(databaseCleanup),
  );
  let databaseCleanupFailure: Error | null;
  if (databaseResult.kind === 'value') {
    databaseCleanupFailure = databaseResult.value.databaseFailure;
    notificationCleanupFailure ??= databaseResult.value.notificationFailure;
  } else {
    databaseCleanupFailure = new Error(DATABASE_CLEANUP_FAILURE_MESSAGE);
    if (databaseResult.kind === 'timeout') {
      logger.warn('[forget] local cache wipe timed out; late work remains quarantined');
    } else {
      logger.warn('[forget] local cache wipe failed unexpectedly', databaseResult.error);
    }
  }
  const mediaCleared = await deleteCachedMedia();
  const mediaCleanupFailure = mediaCleared ? null : new Error(MEDIA_CLEANUP_FAILURE_MESSAGE);
  // Confirm legacy Direct Share cleanup before allowing account B. Normal code can no longer
  // publish rows, but an older installed build may have left account A's long-lived names/photos in
  // Android's persistent shortcut cache. Lazy import keeps this module's React-free, node-tested
  // graph off the native bridge at load. A false/throw means removal was not confirmed, so B stays
  // blocked while every other cleanup step still runs.
  let shortcutCleanupFailure: Error | null = null;
  try {
    const { clearShareShortcuts } = await import('./shortcuts/shareShortcuts');
    if (!clearShareShortcuts()) {
      shortcutCleanupFailure = new Error(SHORTCUT_CLEANUP_FAILURE_MESSAGE);
      logger.warn('[forget] could not confirm Direct Share shortcut cleanup');
    }
  } catch (e) {
    shortcutCleanupFailure = new Error(SHORTCUT_CLEANUP_FAILURE_MESSAGE);
    logger.warn('[forget] could not clear Direct Share shortcuts', e);
  }

  // Logs are account-scoped diagnostics too. Clear them LAST, after every cleanup step that can
  // log, then attempt at most a generic development-only warning after the buffer reset. Bound
  // native filesystem I/O so the local wipe cannot hang forever; an incomplete clear keeps B
  // blocked and is retried on connect.
  let persistedLogsCleared = false;
  let logClearError: unknown;
  const persistentLogClear = fileLogSink
    .clear()
    .then((clearedLogs) => {
      persistedLogsCleared = clearedLogs;
    })
    .catch((error: unknown) => {
      logClearError = error;
    });
  const logClearCompleted = await withDeadline(persistentLogClear, LOG_CLEAR_DEADLINE_MS);
  memoryLogSink.clear();
  const logCleanupFailure =
    logClearCompleted && persistedLogsCleared ? null : new Error(LOG_CLEANUP_FAILURE_MESSAGE);

  // The caller must not mistake a completed local wipe for a fully retired account. Marker and
  // tombstone stay closed; connect() sees this rejection, reports it, and retries the whole
  // idempotent cleanup before validating B. Any development log happens only AFTER A's buffers reset.
  const cleanupFailure =
    durableCredentialFailure ??
    candidateDrainFailure ??
    inMemoryCleanupFailure ??
    fcmTokenRetirementFailure ??
    realtimeDrainFailure ??
    uploadDrainFailure ??
    syncDrainFailure ??
    downloadDrainFailure ??
    notificationCleanupFailure ??
    databaseCleanupFailure ??
    mediaCleanupFailure ??
    shortcutCleanupFailure ??
    logCleanupFailure;
  if (cleanupFailure) {
    logger.warn('[forget] account cleanup remains incomplete; next connection will retry', {
      reason: cleanupFailure.message,
      ...(logClearError === undefined
        ? {}
        : { logError: logClearError instanceof Error ? logClearError.name : 'UnknownError' }),
    });
    throw cleanupFailure;
  }
  // Only a user-triggered invalidation needs an out-of-band proof for the successor coordinator.
  // An internal caller is already awaiting this exact outcome and must not leave a reusable hint.
  lastSuccessfulForgetEpoch = invalidateForegroundBoot ? forgetEpoch : -1;
}

/** How many times `forget()` will run the wipe before giving up (see {@link wipeLocalCache}). */
const WIPE_ATTEMPTS = 2;

/**
 * Run the local wipe and CONFIRM it, re-running once if rows survived.
 *
 * `clearLocalCache` is a sequence of independent autocommit statements, each fenced through the
 * process-wide write queue. It cannot be one SQL transaction for the seconds it may take to delete
 * every message (see its own note). A partial wipe is still reachable: the process can die between
 * statements, or an ordinary writer not yet migrated to the queue can interleave rows. Either way
 * the previous account's conversations remain on the device — the exact leak Disconnect exists to
 * close. The separately queue-fenced residue read prevents a neighbouring transaction's temporary
 * empty view from being accepted as clean.
 *
 * A second pass fixes both: whatever raced the first one has stopped by then (the authorization
 * window is closed and durable session state is retired or its failure was logged), and the wipe is
 * idempotent. Anything still dirty after that makes the wipe fail closed: the tombstone stays in
 * place and a later boot/connect retries before it can authorize another account.
 */
async function wipeLocalCache(db: AppDatabase): Promise<boolean> {
  for (let attempt = 1; attempt <= WIPE_ATTEMPTS; attempt++) {
    try {
      await clearLocalCache(db);
    } catch (e) {
      logger.warn(`[forget] local cache wipe attempt ${attempt} failed`, e);
    }
    if (!(await localCacheDirty(db))) return true;
    logger.warn(`[forget] local cache still populated after wipe attempt ${attempt}`);
  }
  return false;
}

type ForgetOutcome = { ok: true } | { ok: false; error: unknown };

interface ForgetRun {
  /** The real public result, including a credential-removal rejection. */
  run: Promise<void>;
  /** A non-rejecting view used by boot/connect coordination. */
  outcome: Promise<ForgetOutcome>;
  /** A user-visible Disconnect needs a successor that joins this published cleanup. */
  restartForegroundBoot: boolean;
  restartDispatched: boolean;
  restartAccepted: boolean;
}

/** The ONE wipe currently running (see {@link forget}). */
let forgetInFlight: ForgetRun | null = null;

function dispatchForgetRestart(run: ForgetRun): void {
  if (!run.restartForegroundBoot || run.restartDispatched) return;
  run.restartDispatched = true;
  run.restartAccepted = restartForegroundBootAfterAccountTransition();
}

/**
 * Forget the connection (see {@link runForget}), publishing the run so `connect()` can wait it out.
 *
 * The tracked promise is a NON-REJECTING view of the run: waiters only need to know the wipe has
 * stopped, and parking a rejecting promise in a module slot that nobody awaits would surface as an
 * unhandled rejection. The caller still receives the real promise, with the real error.
 */
function startForget(invalidateForegroundBoot: boolean): Promise<void> {
  // Public Disconnect owns the user's intent even when Connect has not reached candidate
  // validation/captured connectionAttemptEpoch yet. Internal residual cleanup belongs to that
  // same Connect and must not revoke it, so only the public path calls this hook.
  if (invalidateForegroundBoot) activeConnectRevoker?.();
  // Disconnect may be triggered twice by rapid UI/native events. Starting two idempotent wipes is
  // still unsafe: the second can finish first, connect B can clear the marker, and the slower first
  // can then delete B's freshly synced rows. Every caller therefore shares one underlying run.
  if (forgetInFlight) {
    if (invalidateForegroundBoot && !forgetInFlight.restartForegroundBoot) {
      forgetInFlight.restartForegroundBoot = true;
      invalidateForegroundBootForAccountTransition();
      dispatchForgetRestart(forgetInFlight);
    }
    return forgetInFlight.run;
  }

  // Publish a deferred public promise BEFORE invoking runForget. Its pre-await work deliberately
  // calls native cancel handles, store subscribers and socket.disconnect(); any one of those may
  // synchronously re-enter this function and must observe/share this exact run rather than starting
  // a second wipe in the tiny window before runForget reaches SecureStore.
  let resolveRun!: () => void;
  let rejectRun!: (error: unknown) => void;
  const run = new Promise<void>((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });
  let tracked!: ForgetRun;
  const outcome: Promise<ForgetOutcome> = run
    .then<ForgetOutcome, ForgetOutcome>(
      () => ({ ok: true }),
      (error: unknown) => ({ ok: false, error }),
    )
    .then((result) => {
      // An internally-started cleanup can later be promoted by a public Disconnect. Preserve the
      // exact successful epoch for its already-dispatched successor in that case too.
      if (result.ok && tracked.restartForegroundBoot && tracked.restartAccepted) {
        lastSuccessfulForgetEpoch = connectionAttemptEpoch;
      }
      return result;
    })
    .finally(() => {
      if (forgetInFlight?.run === run) forgetInFlight = null;
      if (tracked.restartForegroundBoot && !tracked.restartAccepted) {
        // Headless/tests may load teardown without the foreground singleton. Do not let a proof
        // intended for its immediate successor leak into an unrelated later lifecycle.
        lastSuccessfulForgetEpoch = -1;
      }
    });
  tracked = {
    run,
    outcome,
    restartForegroundBoot: invalidateForegroundBoot,
    restartDispatched: false,
    restartAccepted: false,
  };
  forgetInFlight = tracked;
  const cleanup = runForget(invalidateForegroundBoot);
  // `runForget` executes synchronously through epoch revocation, coordinator invalidation, account
  // admission closure, and its first durable mutation before yielding this Promise. Starting the
  // successor now is therefore safe; its session adapter sees `forgetInFlight` and joins this run.
  dispatchForgetRestart(tracked);
  void cleanup.then(resolveRun, rejectRun);
  return run;
}

export function forget(): Promise<void> {
  return startForget(true);
}

/** Resolve with a running wipe's outcome, or null when none was active. Never rejects. */
async function awaitForgetIdle(): Promise<ForgetOutcome | null> {
  const running = forgetInFlight;
  return running ? await running.outcome : null;
}

/** Join the current wipe or start one, preserving its real outcome for fail-closed callers. */
async function runOrAwaitForget(): Promise<ForgetOutcome> {
  const running = forgetInFlight;
  if (running) return running.outcome;
  try {
    await startForget(false);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Directories under the app's DOCUMENTS dir that mirror server content (or are pinned to a chat
 * guid). `clearLocalCache` deletes the rows that hold their paths, so every byte left here is
 * unreachable by any code path — on an auto-download account that is gigabytes of photos only
 * "Clear app data" could ever reclaim, and the Disconnect confirmation promises they go.
 *
 * `app-logs.json` is cleared separately as the FINAL wipe step through `FileLogSink`, so it is not
 * listed here. Anything under `Paths.cache` is OS-reclaimable, and backup/share staging owns its
 * own deletion lifecycle.
 */
const WIPED_MEDIA_DIRS = [
  'attachments', // downloadService → expoFetcher
  'server-contact-avatars', // backfillServerAvatars
  'synced-backgrounds', // syncedBackground
  'chat-bg', // the user's own per-chat wallpaper picks — their chat rows go with the wipe
] as const;

/**
 * Confirmed removal of the on-disk media the wipe just orphaned. Its own function (and its own
 * try/catch per directory) because expo-file-system is a native module: the lazy import keeps it
 * out of this module's node-test load graph. A failure does not skip later cleanup, but it keeps a
 * new account blocked. Bounded downloads are cancelled and drained before this final sweep, so a
 * late old-account promotion cannot recreate one of these directories after removal.
 */
async function deleteCachedMedia(): Promise<boolean> {
  let cleared = true;
  try {
    const { Directory, Paths } = await import('expo-file-system');
    for (const name of WIPED_MEDIA_DIRS) {
      try {
        const dir = new Directory(Paths.document, name);
        if (dir.exists) dir.delete();
        if (dir.exists) {
          cleared = false;
          logger.warn(`[forget] cached media dir ${name} still exists after delete`);
        }
      } catch (e) {
        cleared = false;
        logger.warn(`[forget] could not delete cached media dir ${name}`, e);
      }
    }
  } catch (e) {
    cleared = false;
    logger.warn('[forget] filesystem unavailable — cached media left on disk', e);
  }
  return cleared;
}

/** How long `forget()` waits for a dying sync before wiping anyway (see the call site). */
const SYNC_DRAIN_DEADLINE_MS = 20_000;
/** Join a previously quarantined destructive chain briefly; restart is required if it stays hung. */
const ACCOUNT_CLEANUP_JOIN_DEADLINE_MS = 5_000;
/** The filesystem revocation marker makes a late monotonic SecureStore retirement safe to quarantine. */
const CREDENTIAL_CLEANUP_DEADLINE_MS = 5_000;
/** A late token delete could retire account B's token, so it remains quarantined after this bound. */
const FCM_TOKEN_RETIREMENT_DEADLINE_MS = 5_000;
/** DB open + reminder retirement + confirmed two-pass wipe may be slow, but never unbounded. */
const DATABASE_CLEANUP_DEADLINE_MS = 30_000;
/** Realtime work is DB/native presentation only; long downloads run outside this drain. */
const REALTIME_DRAIN_DEADLINE_MS = 5_000;
/** Native cancellation should be prompt; a wedged transfer keeps the next account blocked. */
const DOWNLOAD_DRAIN_DEADLINE_MS = 5_000;
/** Native upload cancellation can resolve publicly before Expo's exact transfer promise settles. */
const UPLOAD_DRAIN_DEADLINE_MS = 5_000;
/** Error capture uses a short DB transaction; a wedge must not make Disconnect wait forever. */
const ERROR_REPORT_DRAIN_DEADLINE_MS = 5_000;
/** Native notification work is ordered, but a wedged bridge must not block the local wipe forever. */
const NOTIFICATION_CLEAR_DEADLINE_MS = 5_000;
/** Persistent logs are filesystem-backed; a wedged bridge must leave the account revoked. */
const LOG_CLEAR_DEADLINE_MS = 5_000;

/** Await `p`, but give up after `ms` — returns false when the deadline won. */
async function withDeadline(p: Promise<void>, ms: number): Promise<boolean> {
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
