import {
  ERROR_DIAGNOSTIC_SITES,
  isVerboseLocalLoggingEnabled,
  projectCapturedErrorDiagnostic,
} from '@core/secure';
import { fileLogSink } from '../logging/fileLogSink';
import { captureError, errorReportSink } from './errorReportSink';

/**
 * Install app-wide handlers that funnel UNCAUGHT errors into the capture queue — the errors nothing
 * else catches today (there is no other global handler). Two hooks, both RN/Hermes globals:
 *
 * 1. `ErrorUtils.setGlobalHandler` — uncaught JS errors (fatal + non-fatal). We CHAIN the previous
 *    handler so RN's redbox / native crash reporting still runs.
 * 2. `HermesInternal.enablePromiseRejectionTracker` — unhandled promise rejections. RN only enables
 *    this under `__DEV__`, so production needs us to enable it to catch swallowed async failures.
 *
 * Idempotent + fully guarded: both globals are `undefined` under Jest and in a non-Hermes/headless
 * context, so this is a safe no-op there. A present hook that throws gets one deferred retry;
 * installation errors are otherwise swallowed because capturing errors must never break boot.
 */
let errorUtilsInstalled = false;
let rejectionTrackerInstalled = false;
let errorUtilsRetryScheduled = false;
let rejectionTrackerRetryScheduled = false;

const INSTALL_RETRY_DELAY_MS = 0;

/** How long a fatal crash waits for its App Logs line and report to reach disk (review M213). */
const FATAL_PERSIST_BUDGET_MS = 750;

/** Start one save without letting a missing or throwing sink break the crash hand-off. */
function startSave(save: () => Promise<unknown>): Promise<unknown> {
  try {
    return save();
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * React Native's fatal handler ends the process. Give the crash's own App Logs line (otherwise held
 * for a 1.5 s batched write) and its encrypted report a bounded moment to reach disk first.
 * Never rejects.
 */
function persistBeforeFatal(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FATAL_PERSIST_BUDGET_MS);
  });
  const saves = Promise.allSettled([
    startSave(() => fileLogSink.flush()),
    startSave(() => errorReportSink.whenDrainsSettled()),
  ]);
  return Promise.race([saves, budget]).then(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

interface ErrorUtilsShape {
  getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
  setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
}
interface HermesInternalShape {
  enablePromiseRejectionTracker?: (options: {
    allRejections: boolean;
    onUnhandled?: (id: number, error: unknown) => void;
    onHandled?: (id: number) => void;
  }) => void;
}

/** Rebuild the Error passed to RN's native/redbox handler so that path cannot print raw prose. */
export function privacySafeGlobalError(error: unknown, isFatal?: boolean): Error {
  const diagnostic = projectCapturedErrorDiagnostic(
    isFatal ? '[fatal] runtime error' : '[uncaught] runtime error',
    error,
    isFatal ? ERROR_DIAGNOSTIC_SITES.runtimeFatal : ERROR_DIAGNOSTIC_SITES.runtimeUncaught,
  );
  const safe = new Error(diagnostic.message);
  safe.name = diagnostic.meta.errorName ?? 'GatorDiagnostic';
  safe.stack = diagnostic.stack;
  return safe;
}

interface ErrorHandlerGlobals {
  ErrorUtils?: ErrorUtilsShape;
  HermesInternal?: HermesInternalShape;
}

/** Returns true only when a present hook threw and is eligible for the one bounded retry. */
function installErrorUtils(): boolean {
  const errorUtils = (globalThis as unknown as ErrorHandlerGlobals).ErrorUtils;
  if (errorUtilsInstalled || !errorUtils?.setGlobalHandler) return false;
  try {
    const prev = errorUtils.getGlobalHandler?.();
    let fatalHandOffStarted = false;
    errorUtils.setGlobalHandler((error, isFatal) => {
      captureError(error, isFatal ? 'fatal' : 'uncaught', { fatal: isFatal });
      // Preserve RN redbox/native fatal reporting without handing that separate native/logcat
      // path the original message, stack, cause, or custom fields. A development build keeps the
      // real error so its red screen and Metro log can locate the bug.
      const forward = (): void => {
        prev?.(
          isVerboseLocalLoggingEnabled() ? error : privacySafeGlobalError(error, isFatal),
          isFatal,
        );
      };
      // Only the first fatal waits; anything after it, and every non-fatal error, goes straight on.
      if (!isFatal || fatalHandOffStarted) {
        forward();
        return;
      }
      fatalHandOffStarted = true;
      void persistBeforeFatal().then(() => {
        try {
          forward();
        } catch {
          // Nothing more can be reported once React Native's own fatal handler fails.
        }
      });
    });
    errorUtilsInstalled = true;
    return false;
  } catch {
    return true;
  }
}

/** Returns true only when a present hook threw and is eligible for the one bounded retry. */
function installRejectionTracker(): boolean {
  const hermes = (globalThis as unknown as ErrorHandlerGlobals).HermesInternal;
  // React Native installs its own tracker in development, which prints each unhandled rejection;
  // replacing it there left developers with no output at all. Release needs ours to capture them.
  if (isVerboseLocalLoggingEnabled()) return false;
  if (rejectionTrackerInstalled || !hermes?.enablePromiseRejectionTracker) return false;
  try {
    hermes.enablePromiseRejectionTracker({
      allRejections: true,
      onUnhandled: (_id, error) => captureError(error, 'unhandledRejection'),
      onHandled: () => {},
    });
    rejectionTrackerInstalled = true;
    return false;
  } catch {
    return true;
  }
}

function scheduleErrorUtilsRetry(): void {
  if (errorUtilsRetryScheduled) return;
  errorUtilsRetryScheduled = true;
  try {
    setTimeout(() => {
      installErrorUtils();
    }, INSTALL_RETRY_DELAY_MS);
  } catch {
    // A diagnostic hook and its retry must never break boot.
  }
}

function scheduleRejectionTrackerRetry(): void {
  if (rejectionTrackerRetryScheduled) return;
  rejectionTrackerRetryScheduled = true;
  try {
    setTimeout(() => {
      installRejectionTracker();
    }, INSTALL_RETRY_DELAY_MS);
  } catch {
    // A diagnostic hook and its retry must never break boot.
  }
}

function installGlobalErrorHandlersAttempt(): void {
  // Keep these attempts separate: a broken ErrorUtils hook must not suppress Hermes reporting, or
  // vice versa.
  const errorUtilsFailed = installErrorUtils();
  const rejectionTrackerFailed = installRejectionTracker();
  if (errorUtilsFailed) scheduleErrorUtilsRetry();
  if (rejectionTrackerFailed) scheduleRejectionTrackerRetry();
}

export function installGlobalErrorHandlers(): void {
  installGlobalErrorHandlersAttempt();
}
