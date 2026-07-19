import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { logSinks } from '@core/secure';
import { getDatabase } from '@db/database';
import { sessionAccessors, useSessionStore } from '@state/sessionStore';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { http } from '../clients';
import { errorReportSink } from './errorReportSink';
import { installGlobalErrorHandlers } from './globalErrorHandlers';
import { runErrorReportQueue, type ClientContext } from './errorReportQueueService';

export { captureError, errorReportSink } from './errorReportSink';
export { installGlobalErrorHandlers } from './globalErrorHandlers';
export { runErrorReportQueue, type ClientContext } from './errorReportQueueService';

/**
 * Wire up error reporting: attach the capture sink to the core logger's TeeSink (so every
 * redacted `error`-level line is buffered for upload) and install the global uncaught-error +
 * unhandled-rejection handlers. Call once at boot (on-device). Safe no-op under Jest/headless.
 */
export function initErrorReporting(): void {
  logSinks.add(errorReportSink);
  installGlobalErrorHandlers();
}

/** This device's constant context for the upload envelope (Android RN client). */
function clientContext(): ClientContext {
  return {
    appVersion: Constants.expoConfig?.version ?? undefined,
    platform: Platform.OS,
    osVersion: String(Platform.Version),
    deviceModel: (Platform.constants as { Model?: string } | undefined)?.Model,
  };
}

let flushing = false;

/**
 * Persist any buffered reports, then upload one batch — gated on: credentials present, the server
 * advertising `supports_error_log_upload`, and the client's `errorReportingEnabled` toggle. A
 * module flag prevents overlapping flushes. Call on app foreground/background, at connected mount,
 * and from the background task. Best-effort — the durable queue retries whatever doesn't upload.
 */
export async function flushErrorReports(): Promise<void> {
  if (flushing) return;
  const { origin, password } = useSessionStore.getState();
  if (!origin || !password) return; // not connected — no auth to POST with
  if (!sessionAccessors.errorLogUploadSupported()) return; // server doesn't accept uploads
  if (!useFeatureSettingsStore.getState().errorReportingEnabled) return; // user turned it off
  flushing = true;
  try {
    await errorReportSink.flushToDb(); // persist the in-memory ring first
    await runErrorReportQueue(getDatabase(), http, Date.now(), clientContext());
  } catch {
    // best-effort — the durable queue retries next time
  } finally {
    flushing = false;
  }
}
