/**
 * Compatibility barrel for evaluation-safe operational services.
 *
 * Re-exporting evaluates every referenced leaf. Therefore entry registrations and startup work
 * must never be added here; `index.js` and explicit boot commands own those effects.
 */

export { ensureSyncedBackgroundForChat } from './backgrounds/syncedBackground';
export { computeBackgroundIsLight } from './backgrounds/luminance';

export { vault, http, getSecretBox, runCryptoSelfTest } from './clients';
export { ensureDatabase, rotateDatabaseKey } from './databaseControl';
export {
  createNewChat,
  sendTyping,
  markRead,
  markUnread,
  markAllChatsRead,
  saveChatDraft,
  setChatMuted,
  setChatArchived,
  setChatPinned,
  updateChatAppearance,
  updateChatCustomization,
  resetChatLocalPreferences,
  movePinnedChat,
  deleteChat,
  type ChatCustomizationPatch,
  type MovePinnedChatOptions,
} from './chatActions';
export { hydrateLock, setAppLockEnabled, completeUnlock } from './lock';
export {
  startSync,
  refreshInbox,
  maybeResumeSync,
  ensureChatSynced,
  startChatRepair,
  restoreDeletedChat,
  startFullRepair,
  cancelFullRepair,
  type ChatRepairResult,
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
export { initErrorReporting, flushErrorReports, runErrorReportQueue } from './errors';
