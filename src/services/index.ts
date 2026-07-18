/**
 * Composition root — pure re-export barrel.
 *
 * The service layer is split into leaf modules (each a single responsibility); this barrel
 * simply re-exports their public surface so every `@/services` importer stays untouched.
 * Re-exporting from a leaf still evaluates it, so its module-eval side effects are preserved
 * (the sink/router singletons and `devPush.start(dispatchRealtimeEvent)` in ./realtimeControl).
 */

export { ensureSyncedBackground } from './backgrounds/syncedBackground';
export { computeBackgroundIsLight } from './backgrounds/luminance';

export { vault, http, getSecretBox, runCryptoSelfTest } from './clients';
export { getCertPins, setCertPins, applyStoredCertPins } from './certPins';
export { ensureDatabase, rotateDatabaseKey } from './databaseControl';
export { createNewChat, sendTyping, markRead, markUnread } from './chatActions';
export { hydrateLock, setAppLockEnabled, completeUnlock } from './lock';
export { startSync, refreshInbox, maybeResumeSync, ensureChatSynced } from './syncControl';
export {
  dispatchRealtimeEvent,
  devPush,
  startRealtime,
  pauseRealtime,
  resumeRealtime,
  applyNewServerUrl,
} from './realtimeControl';
export { hydrateSession, boot, connect, forget } from './bootstrap';
