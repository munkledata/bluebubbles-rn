import { captureError } from './errorReportSink';

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
 * context, so this is a safe no-op there. Installation errors are swallowed — capturing errors must
 * never break boot.
 */
let installed = false;

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

export function installGlobalErrorHandlers(): void {
  if (installed) return;
  installed = true;
  try {
    const g = globalThis as unknown as {
      ErrorUtils?: ErrorUtilsShape;
      HermesInternal?: HermesInternalShape;
    };

    const errorUtils = g.ErrorUtils;
    if (errorUtils?.setGlobalHandler) {
      const prev = errorUtils.getGlobalHandler?.();
      errorUtils.setGlobalHandler((error, isFatal) => {
        captureError(error, isFatal ? 'fatal' : 'uncaught', { fatal: isFatal });
        prev?.(error, isFatal); // preserve RN redbox / native fatal reporting
      });
    }

    g.HermesInternal?.enablePromiseRejectionTracker?.({
      allRejections: true,
      onUnhandled: (_id, error) => captureError(error, 'unhandledRejection'),
      onHandled: () => {},
    });
  } catch {
    // never let error-handler installation break boot
  }
}
