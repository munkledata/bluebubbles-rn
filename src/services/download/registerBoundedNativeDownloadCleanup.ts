import { cleanupAbandonedBoundedDownloadPartials } from './boundedNativeDownload';

// Explicit bundle-entry side effect: sweep a process-killed request before any headless or
// foreground transfer can start. A transfer retries this preparation if the native filesystem is
// unavailable during the early process-start pass.
try {
  cleanupAbandonedBoundedDownloadPartials();
} catch {
  // The implementation retains its unprepared state and retries before the first transfer.
}
