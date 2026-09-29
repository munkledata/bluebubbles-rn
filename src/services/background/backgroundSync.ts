import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { HttpClient } from '@core/api/http';
import * as serverApi from '@core/api/endpoints/server';
import type { ServerInfo } from '@core/models/serverInfo';
import {
  currentRcsProviderEpoch,
  isCurrentRcsChatGuid,
  isCurrentRcsMessageGuid,
} from '@core/rcs/providerIdentity';
import { logger } from '@core/secure';
import { kvGet } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { ERROR_REPORTING_CONSENT_KEY, useFeatureSettingsStore } from '@state/featureSettingsStore';
import { accountRevocationMarker, vault } from '../clients';
import { ensureDatabase } from '../databaseControl';
import { runErrorReportQueue } from '../errors/errorReportQueueService';
import { flushPersistentLogsForHeadlessCompletion } from '../logging/fileLogSink';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';
import { expoAttachmentUploader, expoFileExists } from '../send/attachmentUpload';
import { runOutgoingQueue, type OutgoingQueueIO } from '../send/outgoingQueueService';
import {
  fixedRcsCapabilitySource,
  messageTargetServerAuthorization,
} from '../send/rcsAttemptCapability';
import { runDueScheduled } from '../send/scheduleService';
import { httpSyncApi, incrementalSync } from '../sync';
import { runTrackedSync } from '../syncControl';
import { runBackgroundSync, type BackgroundAccountScope } from './backgroundSyncOrchestrator';

export const BG_SYNC_TASK = 'gator-bg-sync';

/** Explicit per-wake ceilings: WorkManager timing is inexact and one wake must not drain forever. */
export const BACKGROUND_SYNC_MAX_PAGES = 4;
// Schedule handoff can include one bounded HTTP settlement per row. Keep this phase short enough
// to finish cleanly instead of revoking its crash-recovery scope midway through a live claim.
export const BACKGROUND_SCHEDULE_MAX_ROWS = 2;
export const BACKGROUND_OUTGOING_MAX_ROWS = 10;
/**
 * Stop the complete work graph before Samsung's observed ~75-second worker timeout. The remaining
 * five seconds belong to cooperative cleanup and deadline-bounded persistent-log finalization.
 */
export const BACKGROUND_CALLBACK_WORK_WINDOW_MS = 50_000;
export const BACKGROUND_CALLBACK_FINALIZATION_WINDOW_MS = 55_000;
export const BACKGROUND_WAKE_ADMISSION_BUDGET_MS = BACKGROUND_CALLBACK_WORK_WINDOW_MS;
/** Per attachment attempt; safely below the queue row's 120-second ownership lease. */
export const BACKGROUND_ATTACHMENT_UPLOAD_TIMEOUT_MS = 60_000;

interface BackgroundCallbackLifetime {
  readonly signal: AbortSignal;
  readonly expired: Promise<void>;
  readonly finalizationDeadlineAt: number;
  isCurrent(): boolean;
  didExpire(): boolean;
  remainingWorkMs(): number;
  finish(): void;
}

const callbackMonotonicNow = (): number => globalThis.performance?.now?.() ?? Date.now();

/** One absolute owner for a native WorkManager callback and every continuation it launches. */
function createBackgroundCallbackLifetime(callbackStartedAt: number): BackgroundCallbackLifetime {
  const controller = new AbortController();
  const workDeadlineAt = callbackMonotonicNow() + BACKGROUND_CALLBACK_WORK_WINDOW_MS;
  const finalizationDeadlineAt = callbackStartedAt + BACKGROUND_CALLBACK_FINALIZATION_WINDOW_MS;
  let current = true;
  let expired = false;
  let resolveExpired!: () => void;
  const expiredPromise = new Promise<void>((resolve) => {
    resolveExpired = resolve;
  });
  const expire = (): void => {
    if (!current) return;
    expired = true;
    current = false;
    controller.abort(new Error('Background callback work deadline expired'));
    resolveExpired();
  };
  const deadlineTimer = setTimeout(expire, BACKGROUND_CALLBACK_WORK_WINDOW_MS);
  if (typeof deadlineTimer === 'object' && 'unref' in deadlineTimer) deadlineTimer.unref();
  const expireIfDue = (): void => {
    if (current && callbackMonotonicNow() >= workDeadlineAt) expire();
  };

  return {
    signal: controller.signal,
    expired: expiredPromise,
    finalizationDeadlineAt,
    isCurrent: () => {
      expireIfDue();
      return current;
    },
    didExpire: () => {
      expireIfDue();
      return expired;
    },
    remainingWorkMs: () => {
      expireIfDue();
      return Math.max(0, workDeadlineAt - callbackMonotonicNow());
    },
    finish: () => {
      clearTimeout(deadlineTimer);
      current = false;
    },
  };
}

/**
 * A timed-out native callback may return while an uncooperative continuation is still unwinding.
 * Keep replacement workers fenced until that exact continuation really settles.
 */
interface ActiveBackgroundSyncOwner {
  callbackFinished: boolean;
  continuationFinished: boolean;
}

let activeBackgroundSyncOwner: ActiveBackgroundSyncOwner | null = null;

function releaseBackgroundSyncOwner(owner: ActiveBackgroundSyncOwner): void {
  if (activeBackgroundSyncOwner === owner && owner.callbackFinished && owner.continuationFinished) {
    activeBackgroundSyncOwner = null;
  }
}

/** Keep the killed-process entry independent from the UI-facing `send` composition barrel. */
const backgroundOutgoingQueueIO: OutgoingQueueIO = {
  upload: expoAttachmentUploader,
  fileExists: expoFileExists,
};

function asRealtimeLease(scope: BackgroundAccountScope): RealtimeDeliveryLease {
  // The orchestrator's scope is intentionally the same tiny structural contract, but it also
  // checks the durable revocation marker on every call (not merely the in-memory generation).
  return scope;
}

async function reconcileBackgroundMessageNotifications(
  db: AppDatabase,
  scope: BackgroundAccountScope,
): Promise<void> {
  const { reconcileMessageNotificationsWithDatabase } =
    await import('../notifications/notifeeService');
  await reconcileMessageNotificationsWithDatabase(db, asRealtimeLease(scope));
}

/** Hand due local schedules to the outgoing queue; the runner owns its once-per-generation recovery. */
async function recoverAndDrainBackgroundSchedules(
  db: AppDatabase,
  http: HttpClient,
  scope: BackgroundAccountScope,
  serverInfo: ServerInfo,
): Promise<void> {
  const lease = asRealtimeLease(scope);
  await runTrackedRealtimeWork(lease, async () => {
    if (!lease.isCurrent()) return;
    await runDueScheduled(
      db,
      http,
      Date.now(),
      undefined,
      lease,
      BACKGROUND_SCHEDULE_MAX_ROWS,
      () => fixedRcsCapabilitySource(serverInfo),
    );
  });
}

/** Versioned consent is read from this account's DB; missing/corrupt/denied is a safe no-op. */
async function hasDurableErrorReportingConsent(db: AppDatabase): Promise<boolean> {
  return (await kvGet(db, ERROR_REPORTING_CONSENT_KEY)) === 'granted';
}

/** Upload at most the queue service's one bounded batch, with immediate in-process opt-out abort. */
async function flushBackgroundDiagnostics(
  db: AppDatabase,
  http: HttpClient,
  supportsUpload: boolean,
  scope: BackgroundAccountScope,
  callbackSignal: AbortSignal,
): Promise<void> {
  if (!supportsUpload || !scope.isCurrent()) return;
  if (!(await hasDurableErrorReportingConsent(db)) || !scope.isCurrent()) return;

  let consentCurrent = true;
  const controller = new AbortController();
  const revoke = (): void => {
    consentCurrent = false;
    controller.abort(callbackSignal.reason);
  };
  callbackSignal.addEventListener('abort', revoke, { once: true });
  if (callbackSignal.aborted) revoke();
  const unsubscribe = useFeatureSettingsStore.subscribe((state) => {
    // A foreground opt-out changes memory synchronously before its DB write. A fresh headless store
    // is unhydrated and therefore cannot overrule the durable grant just read above.
    if (state.hydrated && !state.errorReportingEnabled) revoke();
  });
  const current = useFeatureSettingsStore.getState();
  if (current.hydrated && !current.errorReportingEnabled) revoke();

  try {
    if (!consentCurrent || !scope.isCurrent()) return;
    await runErrorReportQueue(db, http, Date.now(), {}, asRealtimeLease(scope), {
      isUploadAllowed: () => consentCurrent && scope.isCurrent(),
      signal: controller.signal,
    });
  } finally {
    callbackSignal.removeEventListener('abort', revoke);
    unsubscribe();
  }
}

/** Callable task body: unit tests exercise result semantics without waiting for WorkManager. */
export async function executeBackgroundSyncTask(): Promise<BackgroundTask.BackgroundTaskResult> {
  const callbackStartedAt = Date.now();
  const finalizationDeadlineAt = callbackStartedAt + BACKGROUND_CALLBACK_FINALIZATION_WINDOW_MS;
  let lifetime: BackgroundCallbackLifetime | null = null;
  let owner: ActiveBackgroundSyncOwner | null = null;
  try {
    if (activeBackgroundSyncOwner) {
      logger.warn('[bg] replacement worker deferred while the prior callback is still settling');
      return BackgroundTask.BackgroundTaskResult.Failed;
    }

    lifetime = createBackgroundCallbackLifetime(callbackStartedAt);
    const callbackLifetime = lifetime;
    const run = runBackgroundSync({
      wakeBudgetMs: BACKGROUND_WAKE_ADMISSION_BUDGET_MS,
      vault,
      revocationMarker: accountRevocationMarker,
      captureAccountScope: () => {
        const accountScope = captureRealtimeDeliveryLease();
        return {
          generation: accountScope.generation,
          isCurrent: () => callbackLifetime.isCurrent() && accountScope.isCurrent(),
        };
      },
      runTrackedSync,
      createClient: ({ origin, password }) =>
        new HttpClient({
          getOrigin: () => origin,
          getPassword: () => password,
          lifetimeSignal: callbackLifetime.signal,
        }),
      openDatabase: ensureDatabase,
      fetchServerInfo: (client) => serverApi.serverInfo(client, callbackLifetime.signal),
      serverVersion: (info) => info.server_version ?? '',
      synchronize: async (db, client, serverVersion, scope, info) => {
        await incrementalSync(db, httpSyncApi(client), {
          serverVersion,
          maxPages: BACKGROUND_SYNC_MAX_PAGES,
          shouldAbort: () => !scope.isCurrent(),
          signal: callbackLifetime.signal,
          rcsProviderInfo: info,
        });
        if (scope.isCurrent()) await reconcileBackgroundMessageNotifications(db, scope);
      },
      recoverAndDrainSchedules: recoverAndDrainBackgroundSchedules,
      drainOutgoing: async (db, client, scope, info) => {
        await runOutgoingQueue(
          db,
          client,
          backgroundOutgoingQueueIO,
          Date.now(),
          asRealtimeLease(scope),
          BACKGROUND_OUTGOING_MAX_ROWS,
          Math.max(
            1,
            Math.min(
              BACKGROUND_ATTACHMENT_UPLOAD_TIMEOUT_MS,
              Math.floor(callbackLifetime.remainingWorkMs()),
            ),
          ),
          messageTargetServerAuthorization(info, () => scope.isCurrent()),
          (chatGuid?: string, messageGuid?: string) =>
            scope.isCurrent() &&
            currentRcsProviderEpoch(info) !== null &&
            (chatGuid === undefined || isCurrentRcsChatGuid(info, chatGuid)) &&
            (messageGuid === undefined || isCurrentRcsMessageGuid(info, messageGuid)),
          callbackLifetime.signal,
          () => scope.isCurrent() && info.supports_imessage_location === true,
          currentRcsProviderEpoch(info),
        );
      },
      flushDiagnostics: (db, client, info, scope) =>
        flushBackgroundDiagnostics(
          db,
          client,
          !!info.supports_error_log_upload,
          scope,
          callbackLifetime.signal,
        ),
      onWorkError: (error) => logger.error('[bg] background work failed', 'slwt25up17', error),
      onDiagnosticsError: (error) =>
        logger.debug('[bg] background diagnostics skipped after failure', error),
    });

    owner = { callbackFinished: false, continuationFinished: false };
    activeBackgroundSyncOwner = owner;
    const ownedRun = owner;
    void run
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        ownedRun.continuationFinished = true;
        releaseBackgroundSyncOwner(ownedRun);
      });

    const result = await Promise.race([
      run.then((outcome) => ({ kind: 'outcome' as const, outcome })),
      callbackLifetime.expired.then(() => ({ kind: 'deadline' as const })),
    ]);

    if (result.kind === 'deadline' || callbackLifetime.didExpire()) {
      logger.warn('[bg] background callback reached its work deadline; requesting retry');
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
    const { outcome } = result;

    if (outcome.result === 'retry') {
      logger.warn(`[bg] background work requested retry (${outcome.reason})`);
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
    logger.debug(`[bg] background work finished (${outcome.reason})`);
    return BackgroundTask.BackgroundTaskResult.Success;
  } finally {
    lifetime?.finish();
    // A killed-process worker may be torn down as soon as this promise settles. Do not leave its
    // finite ERROR waiting on the ordinary debounce timer or beyond the native callback window.
    try {
      await flushPersistentLogsForHeadlessCompletion(
        lifetime?.finalizationDeadlineAt ?? finalizationDeadlineAt,
      );
    } finally {
      if (owner) {
        owner.callbackFinished = true;
        releaseBackgroundSyncOwner(owner);
      }
    }
  }
}

export type BackgroundSyncRegistration = 'registered' | 'unavailable' | 'failed';

/** Register the catch-up task (idempotent). Called once from process-owned foreground setup. */
export async function registerBackgroundSync(): Promise<BackgroundSyncRegistration> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) {
      logger.info('[bg] background task unavailable', status);
      return 'unavailable';
    }
    if (!(await TaskManager.isTaskRegisteredAsync(BG_SYNC_TASK))) {
      await BackgroundTask.registerTaskAsync(BG_SYNC_TASK, { minimumInterval: 15 });
    }
    logger.info('[bg] background sync registered');
    return 'registered';
  } catch (error) {
    logger.warn('[bg] register failed', error);
    return 'failed';
  }
}
