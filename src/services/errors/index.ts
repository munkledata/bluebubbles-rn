import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { logSinks } from '@core/secure';
import { getDatabase } from '@db/database';
import { clearErrorReports } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { sessionAccessors, useSessionStore } from '@state/sessionStore';
import { hasErrorReportingConsent, useFeatureSettingsStore } from '@state/featureSettingsStore';
import { http } from '../clients';
import {
  captureRealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation,
} from '../realtime/deliveryCoordinator';
import { errorReportSink } from './errorReportSink';
import { installGlobalErrorHandlers } from './globalErrorHandlers';
import { runErrorReportQueue, type ClientContext } from './errorReportQueueService';

export { captureError, errorReportSink } from './errorReportSink';
export { installGlobalErrorHandlers } from './globalErrorHandlers';
export {
  runErrorReportQueue,
  type ClientContext,
  type ErrorReportRunPolicy,
} from './errorReportQueueService';

let activeUploadController: AbortController | null = null;
let consentObserverInstalled = false;
let purgeInFlight: Promise<void> | null = null;
let nextPurgeGeneration = 0;
let purgeRequiredGeneration: number | null = null;

function captureOpenDatabase(): AppDatabase | null {
  try {
    return getDatabase();
  } catch {
    return null;
  }
}

/** Abort transport, retire the in-memory ring, and purge the durable queue (best-effort). */
function revokeErrorReporting(): Promise<void> {
  activeUploadController?.abort();
  const generation = ++nextPurgeGeneration;
  purgeRequiredGeneration = generation;
  const accountLease = captureRealtimeDeliveryLease();
  const db = captureOpenDatabase();
  // Every revocation retires the sink synchronously, even when an older purge is still running.
  // Otherwise a later account could append to the ring while incorrectly joining A's old purge.
  const reportsIdle = errorReportSink.resetSession();
  const previousPurge = purgeInFlight;
  const purge = (async () => {
    try {
      if (previousPurge) await previousPurge;
      await reportsIdle;
      if (!db || !accountLease.isCurrent()) return;
      await clearErrorReports(db, () => accountLease.isCurrent());
      if (accountLease.isCurrent() && purgeRequiredGeneration === generation) {
        purgeRequiredGeneration = null;
      }
    } catch {
      // Keep purgeRequiredGeneration set. A later disabled or newly re-enabled flush retries the
      // exact barrier before it is allowed to persist or upload any diagnostic.
    }
  })();
  const trackedPurge = purge.finally(() => {
    if (purgeInFlight === trackedPurge) purgeInFlight = null;
  });
  purgeInFlight = trackedPurge;
  return purgeInFlight;
}

function ensureConsentObserver(): void {
  if (consentObserverInstalled) return;
  consentObserverInstalled = true;
  useFeatureSettingsStore.subscribe((state, previous) => {
    const wasAllowed = previous.hydrated && previous.errorReportingEnabled;
    // Unhydrated is capture/network denied, but it is not proof that a durable queue should be
    // erased: a headless process may simply not have read the user's saved grant yet.
    if (state.hydrated && !state.errorReportingEnabled && (wasAllowed || !previous.hydrated)) {
      void revokeErrorReporting();
    }
  });
  const current = useFeatureSettingsStore.getState();
  if (current.hydrated && !current.errorReportingEnabled) void revokeErrorReporting();
}

/**
 * Wire up error reporting: attach the consent-gated capture sink to the core logger's TeeSink and
 * install the global uncaught-error + unhandled-rejection handlers. Installing handlers itself
 * creates no report work; the sink ignores every event until versioned consent is hydrated and ON.
 * Call once at boot (on-device). Safe no-op under Jest/headless.
 */
export function initErrorReporting(): void {
  ensureConsentObserver();
  logSinks.add(errorReportSink);
  installGlobalErrorHandlers();
}

/** This device's constant context for the upload envelope (Android RN client). */
function clientContext(): ClientContext {
  return {
    appVersion: Constants.expoConfig?.version ?? undefined,
    platform: Platform.OS,
    osVersion: String(Platform.Version),
  };
}

let flushInFlight: Promise<void> | null = null;

/**
 * Persist any buffered reports, then upload one batch. Consent is the FIRST gate and is re-checked
 * after every await; credentials and server capability are secondary gates. A module flag prevents
 * overlapping flushes. Call on app foreground/background, at connected mount, and from the
 * background task. Best-effort — the durable queue retries whatever doesn't upload.
 */
export async function flushErrorReports(): Promise<void> {
  ensureConsentObserver();
  if (flushInFlight) return flushInFlight;

  let settleFlight!: () => void;
  const ownedFlight = new Promise<void>((resolve) => {
    settleFlight = resolve;
  });
  flushInFlight = ownedFlight;
  // Capture both authorities before the first await. Hydration and purge settlement may outlive
  // account A, but this invocation must never recapture B's generation or database afterward.
  const accountLease = captureRealtimeDeliveryLease();
  const db = captureOpenDatabase();
  let controller: AbortController | null = null;
  const runIsCurrent = (): boolean => accountLease.isCurrent();
  const unsubscribeInvalidation = subscribeRealtimeGenerationInvalidation(
    accountLease.generation,
    () => controller?.abort(),
  );

  try {
    if (!db || !runIsCurrent()) return;
    // Foreground bootstrap normally hydrates this first, but Android may start a worker in a fresh
    // JS process. Read the versioned choice before deciding whether an existing encrypted queue is
    // consented work or pre-consent data that must be purged. Capture/network remain fail-closed for
    // the whole read because hasErrorReportingConsent() requires hydrated=true.
    if (!useFeatureSettingsStore.getState().hydrated) {
      if (!runIsCurrent()) return;
      await useFeatureSettingsStore.getState().hydrate({ shouldCommit: runIsCurrent });
      if (!runIsCurrent()) return;
      // Hydration contains DB errors and deliberately leaves this false. Unknown consent is not an
      // explicit denial and must not destructively erase a queue that may belong to a saved grant.
      if (!useFeatureSettingsStore.getState().hydrated) return;
    }
    // A failed or stale Off purge remains a hard barrier after Allow. Retire the current ring and
    // retry against this invocation's exact DB before considering any endpoint work.
    if (!hasErrorReportingConsent() || purgeRequiredGeneration !== null) {
      await revokeErrorReporting();
      if (!runIsCurrent() || !hasErrorReportingConsent() || purgeRequiredGeneration !== null) {
        return;
      }
    }
    if (!runIsCurrent()) return;
    const { origin, password } = useSessionStore.getState();
    if (!origin || !password) return; // not connected — no auth to POST with
    if (!sessionAccessors.errorLogUploadSupported()) return; // server doesn't accept uploads
    if (!hasErrorReportingConsent()) return;
    const uploadController = new AbortController();
    controller = uploadController;
    activeUploadController = uploadController;
    await errorReportSink.flushToDb(); // persist the in-memory ring first
    if (!runIsCurrent() || !hasErrorReportingConsent()) return;
    await runErrorReportQueue(db, http, Date.now(), clientContext(), accountLease, {
      isUploadAllowed: hasErrorReportingConsent,
      signal: uploadController.signal,
    });
  } catch {
    // best-effort — the durable queue retries next time
  } finally {
    if (controller && activeUploadController === controller) activeUploadController = null;
    unsubscribeInvalidation();
    if (flushInFlight === ownedFlight) flushInFlight = null;
    settleFlight();
  }
}
