import { serverApi } from '@core/api';
import { hasActiveServerSession, logger } from '@core/secure';
import { resumeChatPurges } from '@db/repositories';
import { DatabaseKeyLostError } from '@db/key';
import type { ReadDb } from '@db/types';
import { areCriticalSettingsHydrated, hydrateAllStores } from '@state/hydrateStores';
import { captureSessionTransportLease, useSessionStore } from '@state/sessionStore';
import { accountRevocationMarker, http, vault } from './clients';
import { ensureDatabase, runSearchTextBackfillOnce } from './databaseControl';
import { runInboxSearchIndexRebuildOnce } from './search/inboxSearchIndexRebuild';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from './realtime/deliveryCoordinator';
import { startRealtime } from './realtimeControl';
import { startSync } from './syncControl';
import {
  type ForegroundSessionSnapshot,
  inspectDurableServerSession,
  isForegroundSessionSnapshot,
  sameForegroundSession,
} from './boot/durableSession';
import type { BootSessionOutcome, BootStageContext } from './boot/bootCoordinator';
import {
  ACCOUNT_STATE_UNAVAILABLE_MESSAGE,
  ForegroundBootKeyLostError,
  ForegroundBootOperationalError,
  ForegroundBootSupersededError,
  RESIDUAL_CLEANUP_FAILURE_MESSAGE,
  SETTINGS_HYDRATION_FAILURE_MESSAGE,
  ServerRevocationPendingError,
  closeForegroundDeliveryAdmission,
  recoverAttachmentCacheWithinDeadline,
  requirePriorForegroundDeliveryDrain,
  type ForegroundBootAttempt,
} from './accountLifecycleState';
import { ACCOUNT_CLEANUP_BOOT_JOIN_DEADLINE_MS, runOrAwaitForget } from './accountCleanup';
import { lifecycle } from './accountLifecycleState';
export { connect } from './connect';
export {
  forget,
  forgetOnThisPhoneOnly,
  previousServerRevocationPending,
  previousUnrevokedServerOrigin,
} from './accountCleanup';
export {
  DATABASE_KEY_LOST_MESSAGE,
  ForegroundBootKeyLostError,
  ForegroundBootOperationalError,
  ForegroundBootSupersededError,
  PREVIOUS_CREDENTIAL_UNREVOKED_MESSAGE,
  disconnectFailureMessage,
  isUnconfirmedCredentialRetirement,
} from './accountLifecycleState';
export type { ForegroundBootAttempt } from './accountLifecycleState';

const DATABASE_BOOT_FAILURE_MESSAGE =
  'Gator could not open your encrypted messages. Try again. If this keeps happening, restart the app.';
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
  return !stageSignal.aborted && attempt.activationEpoch === lifecycle.connectionAttemptEpoch;
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
/** Inspect the durable account boundary for one coordinator-owned foreground run. */
export async function inspectForegroundBootSession(
  context: BootStageContext,
): Promise<BootSessionOutcome<ForegroundBootAttempt>> {
  const activationEpoch = lifecycle.connectionAttemptEpoch;
  const placeholder = { activationEpoch };

  // Public Disconnect starts its successor immediately so the root can show a bounded failure
  // instead of an endless idle spinner. The wipe is published before that restart, so join it
  // before reading either revocation marker or SecureStore; account A stays quarantined throughout.
  const cleanupAlreadyRunning = lifecycle.forgetInFlight;
  if (cleanupAlreadyRunning) {
    // The wipe bounds each of its own steps; outlast them rather than the session deadline (M120).
    context.extendStageDeadline(ACCOUNT_CLEANUP_BOOT_JOIN_DEADLINE_MS);
    const outcome = await cleanupAlreadyRunning.outcome;
    if (context.stageSignal.aborted) throw new ForegroundBootSupersededError();
    // Only the previous server's revocation is unfinished: setup keeps the next connection blocked.
    if (!outcome.ok && !(outcome.error instanceof ServerRevocationPendingError)) {
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

  if (inspection.kind === 'unavailable' || inspection.kind === 'upgrade-quarantined') {
    if (inspection.kind === 'upgrade-quarantined') {
      logger.warn('[boot] credential-upgrade recovery is quarantined', {
        reason: inspection.reason,
      });
    } else if (inspection.source === 'marker') {
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
      { cause: inspection.kind === 'unavailable' ? inspection.error : undefined },
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
    if (lifecycle.lastSuccessfulForgetEpoch === lifecycle.connectionAttemptEpoch)
      return { kind: 'setup' };
    context.extendStageDeadline(ACCOUNT_CLEANUP_BOOT_JOIN_DEADLINE_MS);
    const outcome = await runOrAwaitForget();
    // This cleanup intentionally advances lifecycle.connectionAttemptEpoch. Whole-run invalidation still
    // aborts stageSignal, while the cleanup-owned epoch change is allowed to reach setup.
    if (context.stageSignal.aborted) throw new ForegroundBootSupersededError();
    // Only the previous server's revocation is unfinished: setup keeps the next connection blocked.
    if (!outcome.ok && !(outcome.error instanceof ServerRevocationPendingError)) {
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
  let db: ReadDb;
  try {
    db = await ensureDatabase();
  } catch (error) {
    logger.error('[db] initialization failed', 'syjo8z3ok4', error);
    if (error instanceof DatabaseKeyLostError) {
      throw new ForegroundBootKeyLostError(error);
    }
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
  void runInboxSearchIndexRebuildOnce(deliveryLease);
  // A chat delete interrupted by a killed process leaves old rows under the chat's history
  // boundary. Deleting another chat finishes them, but a chat revived before then would show them
  // again (review M061). One query when nothing was interrupted; every chunk commits only while
  // this account is current.
  void resumeChatPurges(db, () => deliveryLease.isCurrent()).catch((error: unknown) => {
    if (deliveryLease.isCurrent())
      logger.warn('[boot] interrupted chat purge resume failed', error);
  });
  const serverInfoLease = captureRealtimeDeliveryLease();
  const serverInfoTransport = captureSessionTransportLease();
  void serverApi
    .serverInfo(http)
    .then((info) => {
      if (!serverInfoLease.isCurrent() || !serverInfoTransport.origin) return;
      useSessionStore
        .getState()
        .setServerInfoForTransport(serverInfoTransport.origin, serverInfoTransport.revision, info);
    })
    .catch((error) => {
      if (serverInfoLease.isCurrent() && serverInfoTransport.isCurrent()) {
        logger.debug('[boot] server-info refresh failed', error);
      }
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
