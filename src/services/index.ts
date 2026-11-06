/**
 * Compatibility barrel for evaluation-safe operational services.
 *
 * Re-exporting evaluates every referenced leaf. Therefore entry registrations and startup work
 * must never be added here; `index.js` and explicit boot commands own those effects.
 */

import type {
  Perf01ColdFixtureHandle,
  Perf02RenderFixtureSource,
} from '@db/devHarness/perfInboxFixtures';

export type { Perf01ColdFixtureHandle, Perf02RenderFixtureSource };

type PerfHarness = typeof import('@db/devHarness/perfInboxFixtures');

/**
 * The PERF fixtures live in the dev DB harness. Metro inlines `__DEV__` as false in release bundles
 * and strips this branch with its require(), so the fixtures and the device benchmark never ship;
 * the type-only import above costs nothing at runtime (fix plan B-4, 2026-11-06).
 */
function perfHarness(): PerfHarness {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- dev-only; Metro drops this branch from release bundles
    return require('@db/devHarness/perfInboxFixtures') as PerfHarness;
  }
  throw new Error('PERF fixtures are development-only.');
}

/** Fixed-name, DEV-only fixture controls; never accept a production database path or key. */
export function prepareDevPerf01ColdFixture(
  ...args: Parameters<PerfHarness['preparePerf01ColdFixture']>
): ReturnType<PerfHarness['preparePerf01ColdFixture']> {
  return perfHarness().preparePerf01ColdFixture(...args);
}
export function openDevPerf01ColdFixture(
  ...args: Parameters<PerfHarness['openPerf01ColdFixture']>
): ReturnType<PerfHarness['openPerf01ColdFixture']> {
  return perfHarness().openPerf01ColdFixture(...args);
}
export function deleteDevPerf01ColdFixture(
  ...args: Parameters<PerfHarness['deletePerf01ColdFixture']>
): ReturnType<PerfHarness['deletePerf01ColdFixture']> {
  return perfHarness().deletePerf01ColdFixture(...args);
}

/** UI-safe DEV entry for the fixed disposable PERF-02 database measurement. */
export async function runDevPerf02InboxBenchmark(
  onFixtureReady?: (source: Perf02RenderFixtureSource, chats: 1_000 | 10_000) => Promise<void>,
  signal?: AbortSignal,
): ReturnType<PerfHarness['runPerf02DeviceInboxBenchmark']> {
  if (!__DEV__) throw new Error('PERF-02 benchmark is development-only.');
  return perfHarness().runPerf02DeviceInboxBenchmark(onFixtureReady, signal);
}

export { ensureSyncedBackgroundForChat } from './backgrounds/syncedBackground';
export { syncGroupPhotos } from './backgrounds/groupPhotos';
export { computeBackgroundIsLight } from './backgrounds/luminance';
export { startAppleFaceTimeCall } from './facetimeCallUiService';
export { createAppleFaceTimeLink } from './facetimeLinkUiService';
export { clearAppleGroupName, createAppleGroup, renameAppleGroup } from './groupRenameUiService';
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
  saveChatDraftReply,
  setChatMuted,
  setChatArchived,
  setChatAutoUnarchive,
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
