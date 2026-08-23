import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { HttpClient } from '@core/api/http';
import * as serverApi from '@core/api/endpoints/server';
import { logger } from '@core/secure';
import { kvGet } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import {
  ERROR_REPORTING_CONSENT_KEY,
  LEGACY_ERROR_REPORTING_KEY,
  useFeatureSettingsStore,
} from '@state/featureSettingsStore';
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
import { runDueScheduled } from '../send/scheduleService';
import { httpSyncApi, incrementalSync } from '../sync';
import { runTrackedSync } from '../syncControl';
import { runBackgroundSync, type BackgroundAccountScope } from './backgroundSyncOrchestrator';

export const BG_SYNC_TASK = 'gator-bg-sync';

/** Explicit per-wake ceilings: WorkManager timing is inexact and one wake must not drain forever. */
export const BACKGROUND_SYNC_MAX_PAGES = 4;
export const BACKGROUND_SCHEDULE_MAX_ROWS = 10;
export const BACKGROUND_OUTGOING_MAX_ROWS = 10;
/** Per attachment attempt; safely below the queue row's 120-second ownership lease. */
export const BACKGROUND_ATTACHMENT_UPLOAD_TIMEOUT_MS = 60_000;

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

/** Hand due local schedules to the outgoing queue; the runner owns its once-per-generation recovery. */
async function recoverAndDrainBackgroundSchedules(
  db: AppDatabase,
  http: HttpClient,
  scope: BackgroundAccountScope,
): Promise<void> {
  const lease = asRealtimeLease(scope);
  await runTrackedRealtimeWork(lease, async () => {
    if (!lease.isCurrent()) return;
    await runDueScheduled(db, http, Date.now(), undefined, lease, BACKGROUND_SCHEDULE_MAX_ROWS);
  });
}

/** Versioned consent is read from this account's DB; missing/corrupt/denied is a safe no-op. */
async function hasDurableErrorReportingConsent(db: AppDatabase): Promise<boolean> {
  const [consent, legacyConsent] = await Promise.all([
    kvGet(db, ERROR_REPORTING_CONSENT_KEY),
    kvGet(db, LEGACY_ERROR_REPORTING_KEY),
  ]);
  return consent === 'granted' || (consent == null && legacyConsent === '1');
}

/** Upload at most the queue service's one bounded batch, with immediate in-process opt-out abort. */
async function flushBackgroundDiagnostics(
  db: AppDatabase,
  http: HttpClient,
  supportsUpload: boolean,
  scope: BackgroundAccountScope,
): Promise<void> {
  if (!supportsUpload || !scope.isCurrent()) return;
  if (!(await hasDurableErrorReportingConsent(db)) || !scope.isCurrent()) return;

  let consentCurrent = true;
  const controller = new AbortController();
  const revoke = (): void => {
    consentCurrent = false;
    controller.abort();
  };
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
    unsubscribe();
  }
}

/** Callable task body: unit tests exercise result semantics without waiting for WorkManager. */
export async function executeBackgroundSyncTask(): Promise<BackgroundTask.BackgroundTaskResult> {
  try {
    const outcome = await runBackgroundSync({
      vault,
      revocationMarker: accountRevocationMarker,
      captureAccountScope: captureRealtimeDeliveryLease,
      runTrackedSync,
      createClient: ({ origin, password }) =>
        new HttpClient({ getOrigin: () => origin, getPassword: () => password }),
      openDatabase: ensureDatabase,
      fetchServerInfo: (client) => serverApi.serverInfo(client),
      serverVersion: (info) => info.server_version ?? '',
      synchronize: async (db, client, serverVersion, scope) => {
        await incrementalSync(db, httpSyncApi(client), {
          serverVersion,
          maxPages: BACKGROUND_SYNC_MAX_PAGES,
          shouldAbort: () => !scope.isCurrent(),
        });
      },
      recoverAndDrainSchedules: recoverAndDrainBackgroundSchedules,
      drainOutgoing: async (db, client, scope) => {
        await runOutgoingQueue(
          db,
          client,
          backgroundOutgoingQueueIO,
          Date.now(),
          asRealtimeLease(scope),
          BACKGROUND_OUTGOING_MAX_ROWS,
          BACKGROUND_ATTACHMENT_UPLOAD_TIMEOUT_MS,
        );
      },
      flushDiagnostics: (db, client, info, scope) =>
        flushBackgroundDiagnostics(db, client, !!info.supports_error_log_upload, scope),
      onWorkError: (error) => logger.error('[bg] background work failed', error),
      onDiagnosticsError: (error) =>
        logger.debug('[bg] background diagnostics skipped after failure', error),
    });

    if (outcome.result === 'retry') {
      logger.warn(`[bg] background work requested retry (${outcome.reason})`);
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
    logger.debug(`[bg] background work finished (${outcome.reason})`);
    return BackgroundTask.BackgroundTaskResult.Success;
  } finally {
    // A killed-process worker may be torn down as soon as this promise settles. Do not leave its
    // finite ERROR waiting on the ordinary debounce timer.
    await flushPersistentLogsForHeadlessCompletion();
  }
}

/**
 * Background catch-up, local-schedule recovery, and outgoing retry. This module is imported by
 * `index.js`, so `defineTask` runs when Android starts a killed/headless JS context, before any
 * Expo Router layout or Zustand hydration.
 */
TaskManager.defineTask(BG_SYNC_TASK, executeBackgroundSyncTask);

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
