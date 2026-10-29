/**
 * Compatibility barrel for evaluation-safe operational services.
 *
 * Re-exporting evaluates every referenced leaf. Therefore entry registrations and startup work
 * must never be added here; `index.js` and explicit boot commands own those effects.
 */

import {
  deletePerf01ColdFixture,
  openPerf01ColdFixture,
  preparePerf01ColdFixture,
  runPerf02DeviceInboxBenchmark,
  type Perf01ColdFixtureHandle,
  type Perf02RenderFixtureSource,
} from '@db/devHarness/perfInboxFixtures';

export type { Perf01ColdFixtureHandle, Perf02RenderFixtureSource };

/** Fixed-name, DEV-only fixture controls; never accepts a production database path or key. */
export const prepareDevPerf01ColdFixture = preparePerf01ColdFixture;
export const openDevPerf01ColdFixture = openPerf01ColdFixture;
export const deleteDevPerf01ColdFixture = deletePerf01ColdFixture;

/** UI-safe DEV entry for the fixed disposable PERF-02 database measurement. */
export async function runDevPerf02InboxBenchmark(
  onFixtureReady?: (source: Perf02RenderFixtureSource, chats: 1_000 | 10_000) => Promise<void>,
  signal?: AbortSignal,
): ReturnType<typeof runPerf02DeviceInboxBenchmark> {
  if (!__DEV__) throw new Error('PERF-02 benchmark is development-only.');
  return runPerf02DeviceInboxBenchmark(onFixtureReady, signal);
}

export { ensureSyncedBackgroundForChat } from './backgrounds/syncedBackground';
export { computeBackgroundIsLight } from './backgrounds/luminance';
export { startAppleFaceTimeCall } from './facetimeCallUiService';
export { createAppleFaceTimeLink } from './facetimeLinkUiService';
export { renameAppleGroup } from './groupRenameUiService';
export {
  prepareAppleGroupPhotoSet,
  removeAppleGroupPhoto,
  type PreparedAppleGroupPhotoSet,
} from './groupPhotoUiService';
export {
  addAppleGroupParticipant,
  leaveAppleGroup,
  removeAppleGroupParticipant,
} from './groupParticipantUiService';

export { vault, http, accountHttp, getSecretBox, runCryptoSelfTest } from './clients';
export { requestServerAddressChange, type ServerAddressChangeRequest } from './serverAddressChange';
export { ensureDatabase, rotateDatabaseKey } from './databaseControl';
export {
  addTextToChatDraft,
  createNewChat,
  findOrCreateRcsChat,
  sendTyping,
  stopAllTyping,
  markRead,
  markUnread,
  markAllChatsRead,
  saveChatDraft,
  setChatMuted,
  setChatArchived,
  setChatPinned,
  updateChatAppearance,
  updateChatCustomization,
  updateHandleColor,
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
  DeletedChatRestoreUnsafeError,
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
export {
  connect,
  forget,
  forgetOnThisPhoneOnly,
  disconnectFailureMessage,
  isUnconfirmedCredentialRetirement,
  PREVIOUS_CREDENTIAL_UNREVOKED_MESSAGE,
  previousServerRevocationPending,
  previousUnrevokedServerOrigin,
} from './bootstrap';
export {
  beginScopedCredentialReplacement,
  beginScopedCredentialUpgrade,
  discardScopedCredentialUpgradeCandidate,
  inspectScopedCredentialUpgradeStatus,
  resumeScopedCredentialUpgrade,
  type ResumeScopedCredentialUpgradeOptions,
  type ScopedCredentialUpgradeStatus,
} from './credentialUpgrade';
export { initErrorReporting, flushErrorReports, runErrorReportQueue } from './errors';
