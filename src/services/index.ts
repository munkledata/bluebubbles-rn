/**
 * Composition root — pure re-export barrel.
 *
 * The service layer is split into leaf modules (each a single responsibility); this barrel
 * simply re-exports their public surface so every `@/services` importer stays untouched.
 * Re-exporting from a leaf still evaluates it, so its module-eval side effects are preserved.
 */

export { ensureSyncedBackground } from './backgrounds/syncedBackground';
export { computeBackgroundIsLight } from './backgrounds/luminance';

export { vault, http, getSecretBox, runCryptoSelfTest } from './clients';
export { ensureDatabase, rotateDatabaseKey } from './databaseControl';
export { createNewChat, sendTyping, markRead, markUnread, deleteChat } from './chatActions';
export { hydrateLock, setAppLockEnabled, completeUnlock } from './lock';
export {
  startSync,
  refreshInbox,
  maybeResumeSync,
  ensureChatSynced,
  startFullRepair,
  cancelFullRepair,
} from './syncControl';
export {
  dispatchRealtimeEvent,
  devPush,
  startRealtime,
  pauseRealtime,
  resumeRealtime,
  retryRealtimeConnection,
  applyNewServerUrl,
} from './realtimeControl';
export { connect, forget, disconnectFailureMessage } from './bootstrap';
export {
  startForegroundBoot,
  retryForegroundBoot,
  unlockForegroundBoot,
  getForegroundBootSnapshot,
  subscribeForegroundBoot,
} from './boot/foregroundBoot';
export { initErrorReporting, flushErrorReports, runErrorReportQueue } from './errors';
