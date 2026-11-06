/** Connect: candidate validation, the account gate and the first open of a new account (moved from bootstrap.ts). */

import { serverApi } from '@core/api';
import { isCleartext, sanitizeServerAddress } from '@core/config';
import { hasActiveServerSession, logger } from '@core/secure';
import type { ReadDb } from '@db/types';
import { areCriticalSettingsHydrated, hydrateAllStores } from '@state/hydrateStores';
import { useSessionStore } from '@state/sessionStore';
import { accountRevocationMarker, candidateClient, vault } from './clients';
import { connectToServer } from './connection';
import { ensureDatabase } from './databaseControl';
import { runInboxSearchIndexRebuildOnce } from './search/inboxSearchIndexRebuild';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from './realtime/deliveryCoordinator';
import { startRealtime } from './realtimeControl';
import { startSync } from './syncControl';
import { type DurableSessionInspection, inspectDurableServerSession } from './boot/durableSession';
import type { BootIssue } from './boot/bootStateMachine';
import { reportForegroundBootIssue } from './boot/foregroundBootInvalidation';
import {
  ACCOUNT_STATE_UNAVAILABLE_MESSAGE,
  RESIDUAL_CLEANUP_FAILURE_MESSAGE,
  SETTINGS_HYDRATION_FAILURE_MESSAGE,
  disconnectFailureMessage,
  quarantineConnectCandidate,
  quarantineConnectDatabase,
  recoverAttachmentCacheWithinDeadline,
  settleWithinDeadline,
  trackConnectCandidate,
  lifecycle,
} from './accountLifecycleState';
import { awaitForgetIdle, runOrAwaitForget } from './accountCleanup';

const DIFFERENT_SAVED_ACCOUNT_MESSAGE =
  'Gator found a different saved connection. Restart the app to restore it, then use Disconnect before connecting to another server.';
const CONNECT_ACCOUNT_GATE_DEADLINE_MS = 10_000;
const CONNECT_CANDIDATE_DEADLINE_MS = 45_000;
const CONNECT_DATABASE_DEADLINE_MS = 30_000;
const CONNECT_SETTINGS_DEADLINE_MS = 15_000;
const CONNECT_GATE_TIMEOUT_MESSAGE =
  'Gator is still checking previous account state. Try again in a moment.';
const CONNECT_CANDIDATE_TIMEOUT_MESSAGE =
  'The connection attempt took too long. Check the server and try again.';
const CONNECT_CANDIDATE_QUARANTINE_MESSAGE =
  'The previous connection attempt is still stopping. Try again in a moment.';
const CONNECT_DATABASE_QUARANTINE_MESSAGE =
  'Database startup is still pending. Fully close and reopen Gator before trying again.';
const CONNECT_DATABASE_TIMEOUT_MESSAGE =
  'Gator could not finish opening your encrypted messages. Fully close and reopen Gator to try again.';
const ACCOUNT_CLEANUP_QUARANTINE_MESSAGE =
  'Previous account cleanup is still pending. Fully close and reopen Gator before connecting again.';
function unavailableConnectionMessage(
  inspection: Extract<DurableSessionInspection, { kind: 'unavailable' | 'upgrade-quarantined' }>,
): string {
  if (inspection.kind === 'upgrade-quarantined') {
    logger.warn('[connect] credential-upgrade recovery is quarantined', {
      reason: inspection.reason,
    });
  } else if (inspection.source === 'marker') {
    logger.warn('[connect] account revocation marker unreadable — candidate blocked');
  } else {
    logger.warn('[connect] secure session state unreadable — candidate blocked', inspection.error);
  }
  return ACCOUNT_STATE_UNAVAILABLE_MESSAGE;
}
const CANDIDATE_GATE_CANCELLED = Symbol('candidate-gate-cancelled');
/**
 * Recheck durable account state immediately before validating a candidate server.
 *
 * A retained active tuple may only be recovered with the exact same normalized origin/password.
 * Silently replacing it with account B would retain account A's encrypted DB. A different account
 * must therefore restore A, use the explicit Disconnect flow, and let that confirmed wipe finish.
 */
async function prepareCandidateConnection(
  origin: string,
  password: string,
  cleanupAlreadyCompleted: boolean,
  isAuthorized: () => boolean,
): Promise<string | null | typeof CANDIDATE_GATE_CANCELLED> {
  const inspection = await inspectDurableServerSession(vault, accountRevocationMarker);
  if (!isAuthorized()) return CANDIDATE_GATE_CANCELLED;
  if (inspection.kind === 'unavailable' || inspection.kind === 'upgrade-quarantined') {
    return unavailableConnectionMessage(inspection);
  }

  if (
    inspection.kind === 'empty' ||
    inspection.kind === 'revoked' ||
    inspection.kind === 'cleanup-required'
  ) {
    if (
      !cleanupAlreadyCompleted &&
      lifecycle.lastSuccessfulForgetEpoch !== lifecycle.connectionAttemptEpoch
    ) {
      // This is the only mutating branch. A deadline must revoke it before a delayed vault read
      // can wake and wipe a newer connection attempt.
      if (!isAuthorized()) return CANDIDATE_GATE_CANCELLED;
      const cleanup = await runOrAwaitForget();
      if (!isAuthorized()) return CANDIDATE_GATE_CANCELLED;
      if (!cleanup.ok) return disconnectFailureMessage(cleanup.error);
      // The marker/tombstone deliberately remains until the candidate credential commit completes.
      // Reinspect only to prove the durable state is still readable before making a network call.
      return prepareCandidateConnection(origin, password, true, isAuthorized);
    }
    return null;
  }

  const saved = inspection.session;
  if (hasActiveServerSession(saved.sessionState, saved.origin, saved.password)) {
    const savedOrigin = saved.origin ? sanitizeServerAddress(saved.origin) : null;
    if (savedOrigin !== origin || saved.password !== password) {
      return DIFFERENT_SAVED_ACCOUNT_MESSAGE;
    }
  }
  return null;
}
/**
 * Validate + connect to a server, updating the session store with the outcome.
 *
 * `allowCleartext` must be explicitly set true to connect to a plaintext `http://` origin
 * (e.g. a LAN/IP server the user knowingly trusts). By default we reject it: we must never
 * attach the Bearer credential to an unencrypted origin without that acknowledgement. Android's
 * generated manifest permits cleartext for explicitly approved LAN compatibility, so this
 * application-level decision is the credential-safety gate.
 */
export async function connect(
  rawOrigin: string,
  password: string,
  allowCleartext = false,
): Promise<void> {
  const store = useSessionStore.getState();
  if (lifecycle.connectInFlight) {
    // Do not let a rapid second QR/button event interleave `writing -> address -> password -> active`
    // with the first. The screen is already showing the first attempt's Connecting state.
    logger.warn('[connect] ignored a concurrent connection attempt');
    return;
  }
  const origin = sanitizeServerAddress(rawOrigin);
  if (!origin) {
    store.failed('Please enter a valid server URL.');
    return;
  }
  if (isCleartext(origin) && !allowCleartext) {
    store.failed(
      'This server uses an insecure http:// connection. Use https://, or enable insecure connections to continue.',
    );
    return;
  }
  if (!password) {
    store.failed('Enter the server or paired-client password.');
    return;
  }

  // Claim synchronously, before the first await. UI button disabling happens from this same state,
  // but two events can enter this function before React has rendered that disabled prop.
  lifecycle.connectInFlight = true;
  let attemptAuthorized = true;
  let connectionCommitted = false;
  const revokeAttempt = (): void => {
    attemptAuthorized = false;
  };
  lifecycle.activeConnectRevoker = revokeAttempt;
  try {
    store.beginConnecting();
    if (lifecycle.accountCleanupQuarantine) {
      store.failed(ACCOUNT_CLEANUP_QUARANTINE_MESSAGE);
      return;
    }
    if (lifecycle.connectCandidateQuarantine) {
      store.failed(CONNECT_CANDIDATE_QUARANTINE_MESSAGE);
      return;
    }
    if (lifecycle.connectDatabaseQuarantine) {
      store.failed(CONNECT_DATABASE_QUARANTINE_MESSAGE);
      return;
    }
    // A Disconnect navigates away the moment the session resets, but its wipe keeps running behind
    // the setup screen. Connecting on top of that would let its DB delete race the new server's sync.
    const priorCleanupResult = await settleWithinDeadline(
      awaitForgetIdle(),
      CONNECT_ACCOUNT_GATE_DEADLINE_MS,
    );
    if (priorCleanupResult.kind === 'timeout') {
      store.failed(CONNECT_GATE_TIMEOUT_MESSAGE);
      return;
    }
    if (priorCleanupResult.kind === 'error') {
      store.failed(RESIDUAL_CLEANUP_FAILURE_MESSAGE);
      return;
    }
    const priorCleanup = priorCleanupResult.value;
    if (priorCleanup && !priorCleanup.ok) {
      store.failed(disconnectFailureMessage(priorCleanup.error));
      return;
    }

    let cleanupAlreadyCompleted = priorCleanup?.ok === true;
    let attemptEpoch: number;
    while (true) {
      const gateOperation = prepareCandidateConnection(
        origin,
        password,
        cleanupAlreadyCompleted,
        () => attemptAuthorized,
      );
      const gateResult = await settleWithinDeadline(
        gateOperation,
        CONNECT_ACCOUNT_GATE_DEADLINE_MS,
        () => {
          attemptAuthorized = false;
        },
      );
      if (gateResult.kind === 'timeout') {
        store.failed(CONNECT_GATE_TIMEOUT_MESSAGE);
        return;
      }
      if (gateResult.kind === 'error') {
        store.failed(RESIDUAL_CLEANUP_FAILURE_MESSAGE);
        return;
      }
      const gateFailure = gateResult.value;
      if (gateFailure === CANDIDATE_GATE_CANCELLED) return;
      if (gateFailure) {
        store.failed(gateFailure);
        return;
      }

      // A second/public Disconnect may have started while the final marker/SecureStore inspection
      // was suspended. Join it and re-run the durable gate. Only capture the candidate epoch in the
      // same synchronous turn that proves no wipe is published; a later forget increments it.
      const overlappingCleanup = lifecycle.forgetInFlight;
      if (!overlappingCleanup) {
        attemptEpoch = lifecycle.connectionAttemptEpoch;
        break;
      }
      const overlappingResult = await settleWithinDeadline(
        overlappingCleanup.outcome,
        CONNECT_ACCOUNT_GATE_DEADLINE_MS,
      );
      if (overlappingResult.kind === 'timeout') {
        store.failed(CONNECT_GATE_TIMEOUT_MESSAGE);
        return;
      }
      if (overlappingResult.kind === 'error') {
        store.failed(RESIDUAL_CLEANUP_FAILURE_MESSAGE);
        return;
      }
      const overlappingOutcome = overlappingResult.value;
      if (!overlappingOutcome.ok) {
        store.failed(disconnectFailureMessage(overlappingOutcome.error));
        return;
      }
      cleanupAlreadyCompleted = true;
    }

    // A residual wipe resets session UI synchronously. Put this attempt back into Connecting only
    // after that wipe has finished and immediately before candidate validation begins.
    store.beginConnecting();
    const isAttemptCurrent = (): boolean =>
      attemptAuthorized && attemptEpoch === lifecycle.connectionAttemptEpoch;
    const client = candidateClient(origin, password);
    const candidateOperation = connectToServer(origin, password, {
      fetchServerInfo: () => serverApi.serverInfo(client),
      vault,
      revocationMarker: accountRevocationMarker,
      isAttemptCurrent,
    });
    trackConnectCandidate(candidateOperation);
    const candidateResult = await settleWithinDeadline(
      candidateOperation,
      CONNECT_CANDIDATE_DEADLINE_MS,
      () => {
        attemptAuthorized = false;
        quarantineConnectCandidate(candidateOperation);
      },
    );
    if (candidateResult.kind === 'timeout') {
      store.failed(CONNECT_CANDIDATE_TIMEOUT_MESSAGE);
      return;
    }
    if (candidateResult.kind === 'error') {
      attemptAuthorized = false;
      logger.warn('[connect] candidate validation failed unexpectedly', candidateResult.error);
      store.failed('Unexpected error while connecting.');
      return;
    }
    const result = candidateResult.value;

    // Disconnect can invalidate the attempt in the microtask gap after candidate validation or a
    // final vault write. It has already reset the store and marked the account revoked; do not
    // overwrite that authoritative state with either Connected or a stale candidate error.
    if (!isAttemptCurrent() || (!result.ok && result.kind === 'cancelled')) return;
    if (result.ok) {
      // A validated server is not enough to expose cached UI or start sync/socket work. On a fresh
      // process the kv-backed settings stores are still at module defaults until the encrypted DB is
      // open. Restore them under this candidate's ownership first; Disconnect invalidates the guard.
      let db: ReadDb;
      const databaseOperation = ensureDatabase();
      const databaseResult = await settleWithinDeadline(
        databaseOperation,
        CONNECT_DATABASE_DEADLINE_MS,
        () => {
          attemptAuthorized = false;
          quarantineConnectDatabase(databaseOperation);
        },
      );
      if (databaseResult.kind === 'timeout') {
        void pauseRealtimeDeliveries();
        store.failed(CONNECT_DATABASE_TIMEOUT_MESSAGE);
        return;
      }
      if (databaseResult.kind === 'error') {
        logger.error(
          '[connect] database initialization failed',
          'skjyhvynmb',
          databaseResult.error,
        );
        if (isAttemptCurrent()) {
          void pauseRealtimeDeliveries();
          store.failed(SETTINGS_HYDRATION_FAILURE_MESSAGE);
        }
        return;
      }
      db = databaseResult.value;
      if (!isAttemptCurrent()) return;
      const settingsResult = await settleWithinDeadline(
        hydrateAllStores({
          shouldCommit: isAttemptCurrent,
          onError: (error) => logger.warn('[connect] settings hydration failed', error),
        }),
        CONNECT_SETTINGS_DEADLINE_MS,
        () => {
          attemptAuthorized = false;
        },
      );
      if (settingsResult.kind === 'timeout') {
        void pauseRealtimeDeliveries();
        store.failed(`${SETTINGS_HYDRATION_FAILURE_MESSAGE} Settings loading took too long.`);
        return;
      }
      if (settingsResult.kind === 'error') {
        if (!isAttemptCurrent()) return;
        logger.warn('[connect] settings hydration registry failed', settingsResult.error);
        void pauseRealtimeDeliveries();
        store.failed(SETTINGS_HYDRATION_FAILURE_MESSAGE);
        return;
      }
      if (!isAttemptCurrent()) return;
      if (!areCriticalSettingsHydrated()) {
        void pauseRealtimeDeliveries();
        store.failed(SETTINGS_HYDRATION_FAILURE_MESSAGE);
        return;
      }
      resumeRealtimeDeliveries();
      const cacheLease = captureRealtimeDeliveryLease();
      const reportConnectIssue = (issue: BootIssue): void => {
        if (cacheLease.isCurrent() && isAttemptCurrent()) reportForegroundBootIssue(issue);
      };
      const cacheRecovery = await recoverAttachmentCacheWithinDeadline(
        db,
        cacheLease,
        isAttemptCurrent,
        'connect',
        reportConnectIssue,
      );
      if (cacheRecovery === 'stale' || !cacheLease.isCurrent() || !isAttemptCurrent()) return;
      store.connected(origin, password, result.serverInfo);
      connectionCommitted = true;
      void runInboxSearchIndexRebuildOnce(cacheLease);
      void startSync().catch((error) => {
        if (!cacheLease.isCurrent()) return;
        logger.warn('[connect] initial sync failed to start', error);
        reportConnectIssue({
          stage: 'sync',
          level: 'degraded',
          code: 'initial-sync-unavailable',
          userMessage: 'Messages may be out of date until sync retries.',
        });
      });
      void startRealtime({ reportIssue: reportConnectIssue }).catch((error) => {
        if (!cacheLease.isCurrent()) return;
        logger.warn('[connect] realtime startup failed', error);
        reportConnectIssue({
          stage: 'realtime',
          level: 'degraded',
          code: 'realtime-unavailable',
          userMessage: 'Live updates are unavailable; pull to refresh while Gator retries.',
        });
      });
    } else {
      store.failed(result.message);
    }
  } finally {
    // Successful optional work keeps reporting through this exact epoch/lease after `connect`
    // returns. Disconnect revokes both; every unsuccessful attempt is revoked here immediately.
    if (!connectionCommitted) attemptAuthorized = false;
    if (lifecycle.activeConnectRevoker === revokeAttempt) lifecycle.activeConnectRevoker = null;
    lifecycle.connectInFlight = false;
  }
}
