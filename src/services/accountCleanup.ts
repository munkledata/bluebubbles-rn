/** Disconnect: credential retirement, the account cleanup sequence and the forget entry points (moved from bootstrap.ts). */

import { deviceCredentialsApi, serverApi } from '@core/api';
import { ApiError } from '@core/api/errors';
import { strictServerOrigin } from '@core/config';
import { FCM_ENABLED } from '@core/realtime';
import {
  CREDENTIAL_REMOVAL_FAILURE_MESSAGE,
  inspectCredentialUpgradeJournal,
  inspectReplacedCredentialRecord,
  isScopedDeviceCredential,
  logger,
  memoryLogSink,
  retireReplacedCredentialRecord,
  revokedCredentialUpgradeJournal,
  serializeCredentialUpgradeJournal,
  SERVER_SESSION_STATE,
} from '@core/secure';
import { clearLocalCache, listReminders, localCacheDirty } from '@db/repositories';
import type { ReadDb } from '@db/types';
import { useSessionStore } from '@state/sessionStore';
import { accountRevocationMarker, fixedCredentialClient, vault } from './clients';
import { fileLogSink } from './logging/fileLogSink';
import { retireFcmDeviceEncryptionState } from './notifications/fcmEncryptionState';
import { ensureDatabase } from './databaseControl';
import { invalidateAttachmentCacheRecoveryReadiness } from './download/attachmentCacheRecovery';
import { pauseRealtimeDeliveries } from './realtime/deliveryCoordinator';
import { getSocket, setSocket } from './realtimeControl';
import { stopDeviceNetworkWatch } from './networkReachability';
import { stopReachabilityWatch } from './reachability';
import { uploadRegistry } from './send/uploadControl';
import { resetSessionScopedState } from './sessionScopedState';
import { awaitSyncIdle } from './syncControl';
import {
  invalidateForegroundBootForAccountTransition,
  restartForegroundBootAfterAccountTransition,
} from './boot/foregroundBootInvalidation';
import {
  CREDENTIAL_UPGRADE_RETIREMENT_FAILURE_MESSAGE,
  FOREGROUND_DELIVERY_CLEANUP_DEADLINE_MS,
  ServerRevocationPendingError,
  quarantineAccountCleanup,
  settleWithinDeadline,
  withDeadline,
  type DeadlineSettlement,
} from './accountLifecycleState';
import { lifecycle } from './accountLifecycleState';

const FCM_TOKEN_RETIREMENT_FAILURE_MESSAGE =
  'Push notification retirement for the previous connection could not be confirmed.';
const FCM_KEY_RETIREMENT_FAILURE_MESSAGE =
  'Push encryption-key retirement for the previous connection could not be confirmed.';
const REALTIME_DRAIN_FAILURE_MESSAGE =
  'In-flight account work from the previous connection did not stop in time.';
const SYNC_DRAIN_FAILURE_MESSAGE =
  'An in-flight sync from the previous connection did not stop in time.';
const DOWNLOAD_DRAIN_FAILURE_MESSAGE =
  'In-flight media downloads from the previous connection did not stop in time.';
const UPLOAD_DRAIN_FAILURE_MESSAGE =
  'In-flight media uploads from the previous connection did not stop in time.';
const NOTIFICATION_CLEANUP_FAILURE_MESSAGE =
  'Notifications from the previous connection could not be fully removed.';
const DATABASE_CLEANUP_FAILURE_MESSAGE =
  'Local data from the previous connection could not be fully removed.';
const MEDIA_CLEANUP_FAILURE_MESSAGE =
  'Cached media from the previous connection could not be fully removed.';
const SHORTCUT_CLEANUP_FAILURE_MESSAGE =
  'Direct Share shortcuts from the previous connection could not be fully removed.';
const LOG_CLEANUP_FAILURE_MESSAGE =
  'Diagnostic logs from the previous connection could not be fully removed.';
const IN_MEMORY_CLEANUP_FAILURE_MESSAGE =
  'In-memory state from the previous connection could not be fully retired.';
const CONNECT_CANDIDATE_DRAIN_FAILURE_MESSAGE =
  'A previous connection attempt did not stop in time.';
const ACCOUNT_CLEANUP_QUARANTINE_FAILURE_MESSAGE =
  'A previous account cleanup operation did not stop in time.';
const CREDENTIAL_CLEANUP_TIMEOUT_MESSAGE = 'Secure credential retirement did not finish in time.';

/**
 * The cleanup steps `runForget` accounts for, in the order its rejection reports them: the first
 * failed step in this list is the error `forget()` rejects with. A step that is not listed here
 * cannot be marked failed, so the sweep's accounting and its rejection order live in one place.
 */
const FORGET_CLEANUP_STEPS = [
  'durableCredential',
  'credentialUpgradeRetirement',
  'candidateDrain',
  'inMemoryCleanup',
  'fcmTokenRetirement',
  'realtimeDrain',
  'fcmKeyRetirement',
  'uploadDrain',
  'syncDrain',
  'downloadDrain',
  'notificationCleanup',
  'databaseCleanup',
  'mediaCleanup',
  'shortcutCleanup',
  'logCleanup',
] as const;
type ForgetCleanupStep = (typeof FORGET_CLEANUP_STEPS)[number];
/** The message a step reports when it has no error of its own (see {@link ForgetCleanupLedger.fail}). */
const FORGET_CLEANUP_FAILURE_MESSAGES: Readonly<Record<ForgetCleanupStep, string>> = {
  durableCredential: CREDENTIAL_CLEANUP_TIMEOUT_MESSAGE,
  credentialUpgradeRetirement: CREDENTIAL_UPGRADE_RETIREMENT_FAILURE_MESSAGE,
  candidateDrain: CONNECT_CANDIDATE_DRAIN_FAILURE_MESSAGE,
  inMemoryCleanup: IN_MEMORY_CLEANUP_FAILURE_MESSAGE,
  fcmTokenRetirement: FCM_TOKEN_RETIREMENT_FAILURE_MESSAGE,
  realtimeDrain: REALTIME_DRAIN_FAILURE_MESSAGE,
  fcmKeyRetirement: FCM_KEY_RETIREMENT_FAILURE_MESSAGE,
  uploadDrain: UPLOAD_DRAIN_FAILURE_MESSAGE,
  syncDrain: SYNC_DRAIN_FAILURE_MESSAGE,
  downloadDrain: DOWNLOAD_DRAIN_FAILURE_MESSAGE,
  notificationCleanup: NOTIFICATION_CLEANUP_FAILURE_MESSAGE,
  databaseCleanup: DATABASE_CLEANUP_FAILURE_MESSAGE,
  mediaCleanup: MEDIA_CLEANUP_FAILURE_MESSAGE,
  shortcutCleanup: SHORTCUT_CLEANUP_FAILURE_MESSAGE,
  logCleanup: LOG_CLEANUP_FAILURE_MESSAGE,
};

/** Which cleanup steps of one `runForget` sweep failed, and which failure the sweep reports. */
class ForgetCleanupLedger {
  private readonly failures = new Map<ForgetCleanupStep, Error>();

  /**
   * Marks `step` failed: with `error` when the step produced one, otherwise with the step's
   * message from {@link FORGET_CLEANUP_FAILURE_MESSAGES}. A later call for the same step replaces
   * the earlier record.
   */
  fail(step: ForgetCleanupStep, error?: Error): void {
    this.failures.set(step, error ?? new Error(FORGET_CLEANUP_FAILURE_MESSAGES[step]));
  }

  failed(step: ForgetCleanupStep): boolean {
    return this.failures.has(step);
  }

  /** The failure of the earliest failed step in {@link FORGET_CLEANUP_STEPS} order, or null. */
  firstFailure(): Error | null {
    for (const step of FORGET_CLEANUP_STEPS) {
      const failure = this.failures.get(step);
      if (failure) return failure;
    }
    return null;
  }

  /** True when `step` failed and no other step did. */
  isOnlyFailure(step: ForgetCleanupStep): boolean {
    return this.failures.size === 1 && this.failures.has(step);
  }
}
/** The server step of a scoped-credential retirement failed; none of its local steps ran yet. */
class ScopedCredentialServerRevocationError extends Error {
  constructor(readonly serverError: unknown) {
    super('scoped credential server revocation was not confirmed');
    this.name = 'ScopedCredentialServerRevocationError';
  }
}
interface ScopedCredentialRevocationTarget {
  readonly origin: string;
  readonly credential: string;
}
interface ScopedCredentialRevocationSnapshot {
  readonly targets: readonly ScopedCredentialRevocationTarget[];
}
function liveScopedCredentialRevocationTarget(): ScopedCredentialRevocationTarget | null {
  const session = useSessionStore.getState();
  const origin = strictServerOrigin(session.origin);
  if (!origin || !isScopedDeviceCredential(session.password)) return null;
  return Object.freeze({ origin, credential: session.password });
}
/** Capture every scoped bearer in local custody before retirement; never infer or log identity. */
async function captureScopedCredentialRevocationTargets(
  liveTarget: ScopedCredentialRevocationTarget | null,
): Promise<ScopedCredentialRevocationSnapshot> {
  const [storedOrigin, storedCredential, storedUpgrade, storedReplaced] = await Promise.all([
    vault.get('serverAddress'),
    vault.get('serverPassword'),
    vault.get('serverCredentialUpgrade'),
    vault.get('replacedServerCredential'),
  ]);
  const targets: ScopedCredentialRevocationTarget[] = liveTarget ? [liveTarget] : [];
  const remember = (target: ScopedCredentialRevocationTarget): void => {
    if (
      !targets.some(
        (stored) => stored.origin === target.origin && stored.credential === target.credential,
      )
    ) {
      targets.push(Object.freeze(target));
    }
  };
  const upgrade = inspectCredentialUpgradeJournal(storedUpgrade);
  if (upgrade.kind === 'invalid') {
    throw new Error('credential-upgrade revocation custody is invalid');
  }
  if (upgrade.kind === 'valid' && upgrade.journal.phase !== 'revoked') {
    remember({
      origin: upgrade.journal.origin,
      credential: upgrade.journal.candidateCredential,
    });
    // A replacement journal can be the only custody of the bearer it replaced: its record write
    // failed, or the app stopped before it (review M130). Version 2 bearers are always scoped.
    if (upgrade.journal.version === 2) {
      remember({
        origin: upgrade.journal.origin,
        credential: upgrade.journal.previousCredential,
      });
    }
  }
  // A replacement's old bearer still awaiting revocation is revoked with the rest (review M130).
  // An unreadable record names nothing that could be sent; it is simply removed afterwards.
  const replaced = inspectReplacedCredentialRecord(storedReplaced);
  if (replaced.kind === 'valid') remember(replaced.record);
  if (replaced.kind === 'invalid') logger.warn('[forget] replaced-credential record is unreadable');
  const origin = strictServerOrigin(storedOrigin);
  // Deliberately accept an exact scoped tuple under `forgotten`: that is the retry custody left by
  // a prior network failure. Other non-active states are safe too because the independent/session
  // revocation gates, not this snapshot, decide whether a credential may be used normally.
  if (origin && isScopedDeviceCredential(storedCredential)) {
    remember({ origin, credential: storedCredential });
  }
  return Object.freeze({ targets: Object.freeze(targets) });
}
/** Replace credential-bearing upgrade custody with the verified keyless terminal marker. */
async function writeCredentialUpgradeRevokedTombstone(): Promise<void> {
  const serialized = serializeCredentialUpgradeJournal(revokedCredentialUpgradeJournal());
  await vault.set('serverCredentialUpgrade', serialized);
  if ((await vault.get('serverCredentialUpgrade')) !== serialized) {
    throw new Error('credential-upgrade revocation tombstone was not confirmed');
  }
}
/**
 * Drop a replaced bearer's record once it is revoked or Disconnect waived the server step. Confirmed
 * like the tombstone: a record left behind would be revoked against this server from the next
 * account's session (review M130).
 */
async function forgetReplacedServerCredential(): Promise<void> {
  if (!(await retireReplacedCredentialRecord(vault))) {
    throw new Error('replaced-credential record could not be removed');
  }
}
/** Confirm server retirement without ever treating a still-authorized 403/5xx bearer as gone. */
async function revokeScopedCredentialRemotely(
  target: ScopedCredentialRevocationTarget,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCOPED_SELF_REVOKE_DEADLINE_MS);
  try {
    const client = fixedCredentialClient(target.origin, target.credential);
    let result: Awaited<ReturnType<typeof deviceCredentialsApi.revokeSelf>>;
    try {
      result = await deviceCredentialsApi.revokeSelf(client, controller.signal);
    } catch (error) {
      // A revoked, never-issued or mistyped bearer cannot call revoke-self. As in the upgrade
      // discard path, only an independent 401 from the bearer-authenticated info endpoint proves it
      // holds no server authority; any other answer keeps the bearer for another attempt.
      if (!(error instanceof ApiError && error.status === 401)) throw error;
      try {
        await serverApi.serverInfo(client, controller.signal);
      } catch (infoError) {
        if (infoError instanceof ApiError && infoError.status === 401) {
          logger.warn('[forget] scoped credential was already rejected by its server');
          return;
        }
      }
      throw error;
    }
    if (!result.deviceRemoved) {
      logger.warn('[forget] scoped credential revoked but its server push row needs admin cleanup');
    }
  } finally {
    clearTimeout(timeout);
  }
}
async function revokeAllScopedCredentials(
  targets: readonly ScopedCredentialRevocationTarget[],
): Promise<void> {
  const outcomes = await Promise.allSettled(targets.map(revokeScopedCredentialRemotely));
  const failed = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
/**
 * Retire the correlated SecureStore tuple monotonically: tombstone, deletes, then empty-overwrite
 * fallback. The independent marker decides whether the caller may bound this chain safely. The
 * separate upgrade journal is retired only after its tracked writers drain below.
 */
async function retireDurableCredentials(
  independentlyRevoked: boolean,
  preserveCredentialTuple = false,
): Promise<Error | null> {
  let tombstoneWritten = false;
  try {
    await vault.set('serverSessionState', SERVER_SESSION_STATE.forgotten);
    tombstoneWritten = true;
  } catch (error) {
    logger.warn('[forget] session tombstone write failed', error);
  }

  // A scoped bearer whose server revocation is not confirmed remains encrypted retry custody, not
  // an active session. At least one independent durable gate must exist before keeping it. If both
  // gates failed, fall through to the destructive removal path so a restart cannot reactivate it.
  if (preserveCredentialTuple && (tombstoneWritten || independentlyRevoked)) return null;

  const cleared = await Promise.allSettled([
    vault.delete('serverAddress'),
    vault.delete('serverPassword'),
  ]);
  for (const outcome of cleared) {
    if (outcome.status === 'rejected') {
      logger.warn('[forget] credential delete failed — it is still in the vault', outcome.reason);
    }
  }

  // Without either the tombstone or one successful delete, use a different native operation to
  // disable the pair. Active sessions require BOTH credentials to be non-empty.
  if (!tombstoneWritten && cleared.every((outcome) => outcome.status === 'rejected')) {
    const overwritten = await Promise.allSettled([
      vault.set('serverAddress', ''),
      vault.set('serverPassword', ''),
    ]);
    for (const outcome of overwritten) {
      if (outcome.status === 'rejected') {
        logger.warn('[forget] empty credential overwrite fallback failed', outcome.reason);
      }
    }
    if (!independentlyRevoked && overwritten.every((outcome) => outcome.status === 'rejected')) {
      const failure = new Error(CREDENTIAL_REMOVAL_FAILURE_MESSAGE);
      logger.warn(`[forget] ${CREDENTIAL_REMOVAL_FAILURE_MESSAGE} Local wipe will continue.`);
      return failure;
    }
  }
  return null;
}
/** The vault durably reads `forgotten`; a failed or slow read counts as not confirmed. */
async function sessionTombstoneConfirmed(): Promise<boolean> {
  const read = await settleWithinDeadline(
    vault.get('serverSessionState'),
    SESSION_TOMBSTONE_CHECK_DEADLINE_MS,
  );
  return read.kind === 'value' && read.value === SERVER_SESSION_STATE.forgotten;
}
/** Erase retry custody only after every scoped bearer is confirmed revoked, then leave a marker. */
async function finishScopedCredentialRetirement(
  snapshot: ScopedCredentialRevocationSnapshot,
  credentialTupleWasPreserved: boolean,
  independentlyRevoked: boolean,
  waiveRemoteRevocation = false,
): Promise<void> {
  if (snapshot.targets.length > 0) {
    if (waiveRemoteRevocation) {
      // The user chose "Forget on this phone only": erase local custody without the server step.
      logger.warn('[forget] scoped credential forgotten on this device without server revocation');
    } else {
      try {
        await revokeAllScopedCredentials(snapshot.targets);
      } catch (error) {
        // Nothing below has run, so the exact bearer stays as retry custody.
        throw new ScopedCredentialServerRevocationError(error);
      }
    }
  }
  await writeCredentialUpgradeRevokedTombstone();
  // A record that cannot be removed must not also keep the revoked live pair in the vault: retire
  // the pair first, then report whichever failed (review M130).
  const recordFailure = await forgetReplacedServerCredential().then(
    () => null,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  const removalFailure = credentialTupleWasPreserved
    ? await retireDurableCredentials(independentlyRevoked)
    : null;
  if (removalFailure) throw removalFailure;
  if (recordFailure) throw recordFailure;
}
interface DatabaseAccountCleanupResult {
  readonly databaseFailure: Error | null;
  readonly notificationFailure: Error | null;
}
/** One hazardous DB chain: open, retire reminder alarms, then wipe and confirm old-account rows. */
async function cleanupAccountDatabase(): Promise<DatabaseAccountCleanupResult> {
  let notificationFailure: Error | null = null;
  try {
    const db = await ensureDatabase();
    let boundShareCleanupFailed = false;
    try {
      const { discardAccountBoundShareIntake } = await import('./share/shareIntake');
      await discardAccountBoundShareIntake(db);
    } catch (error) {
      boundShareCleanupFailed = true;
      logger.warn('[forget] account-bound share cleanup failed', error);
    }
    try {
      const pending = await listReminders(db);
      if (pending.length > 0) {
        const { cancelReminderNotification } = await import('./notifications/notifeeService');
        let reminderCleanupRejected = false;
        const reminderCleanup = Promise.allSettled(
          pending.map((reminder) => cancelReminderNotification(reminder.notificationId)),
        ).then((outcomes) => {
          const rejection = outcomes.find((outcome) => outcome.status === 'rejected');
          if (rejection?.status === 'rejected') {
            reminderCleanupRejected = true;
            logger.warn('[forget] reminder cancel failed', rejection.reason);
          }
        });
        const reminderCleanupCompleted = await withDeadline(
          reminderCleanup,
          NOTIFICATION_CLEAR_DEADLINE_MS,
        );
        if (!reminderCleanupCompleted) {
          logger.warn('[forget] reminder cleanup timed out — trigger removal remains unconfirmed');
        }
        if (!reminderCleanupCompleted || reminderCleanupRejected) {
          notificationFailure = new Error(NOTIFICATION_CLEANUP_FAILURE_MESSAGE);
        }
      }
    } catch (error) {
      notificationFailure = new Error(NOTIFICATION_CLEANUP_FAILURE_MESSAGE);
      logger.warn('[forget] reminder cancel failed', error);
    }
    return {
      databaseFailure: boundShareCleanupFailed
        ? new Error(DATABASE_CLEANUP_FAILURE_MESSAGE)
        : (await wipeLocalCache(db))
          ? null
          : new Error(DATABASE_CLEANUP_FAILURE_MESSAGE),
      notificationFailure,
    };
  } catch (error) {
    // warn, not error: this runs while disconnecting, and an `error` line would be queued for
    // upload to the very server we are leaving.
    logger.warn('[forget] local cache wipe could not run', error);
    return {
      databaseFailure: new Error(DATABASE_CLEANUP_FAILURE_MESSAGE),
      notificationFailure,
    };
  }
}
/**
 * Forget the connection: clear the credentials, reset the session, and destroy everything this
 * device holds for that server — cached rows (`clearLocalCache`), the reminders' OS alarms, the
 * Direct Share chips, and the downloaded media on disk. The order matters and is explained inline.
 * Every cleanup surface is attempted even if an earlier one fails. A failure leaves the durable
 * revocation gates closed and rejects the run, so a new connection cannot inherit unconfirmed old
 * account state and will retry the whole idempotent cleanup first.
 *
 * Exported through the {@link forget} wrapper, which publishes the run so `connect()` can wait for
 * it — the session reset happens early, so the user is already back on the setup screen while this
 * is still deleting.
 */
async function runForget(
  invalidateForegroundBoot: boolean,
  waiveRemoteRevocation = false,
): Promise<void> {
  // FIRST instruction: revoke a candidate suspended in server validation or SecureStore. The
  // connection layer checks this epoch after every await and before clearing the durable marker;
  // bootstrap checks it again before publishing Connected/starting account work.
  lifecycle.connectionAttemptEpoch += 1;
  const forgetEpoch = lifecycle.connectionAttemptEpoch;
  // Every cleanup step below records its outcome here and the sweep never stops early; the first
  // failed step in FORGET_CLEANUP_STEPS order is what this run rejects with.
  const ledger = new ForgetCleanupLedger();
  // Capture this synchronously with revocation. A candidate that has not reached its 45-second
  // timeout can still have an already-issued SecureStore write in native code; clearing only its
  // JS authorization flag does not cancel that write.
  const connectCandidateAtRevocation =
    lifecycle.activeConnectCandidate ?? lifecycle.connectCandidateQuarantine;
  if (invalidateForegroundBoot) invalidateForegroundBootForAccountTransition();
  invalidateAttachmentCacheRecoveryReadiness();
  // Close admission before the first await, then drain anything admitted just before the tap.
  // Realtime DB writes and native presentation are short tracked commits. Long downloads carry
  // the revoked generation outside this drain and must discard their eventual file/DB commit.
  const realtimeIdle = pauseRealtimeDeliveries();
  // Persist the independent, non-secret filesystem marker before invoking any UI/store/native
  // observer that could throw. Its native implementation uses a
  // synchronous app-private file operation: the attempt happens before the first vault mutation,
  // cannot wait on an unbounded promise, and remains readable when Android Keystore/SecureStore is
  // completely unavailable. A failure is recorded but never skips the local cleanup below.
  let independentlyRevoked = false;
  try {
    accountRevocationMarker.markRevoked();
    independentlyRevoked = true;
  } catch (e) {
    logger.warn('[forget] independent account revocation marker write failed', e);
  }

  // Capture the live bearer before resetting Zustand. The authoritative SecureStore snapshot must
  // wait until tracked adoption writers drain below, or it could miss a candidate that lands after
  // a concurrent read and then overwrite that live authority with the keyless tombstone.
  const liveScopedTarget = liveScopedCredentialRevocationTarget();

  // A Zustand subscriber or native teardown callback is application code and can throw
  // synchronously. Isolate every volatile step so one broken observer cannot skip session
  // revocation, socket retirement, or the durable cleanup below. Any such failure still blocks B;
  // a later retry performs the whole idempotent sweep again in a fresh/unmounted UI context.
  const failedInMemorySurfaces: string[] = [];
  try {
    uploadRegistry.cancelAll();
  } catch {
    failedInMemorySurfaces.push('upload-registry');
  }
  let errorReportsIdle = Promise.resolve();
  try {
    const resetResult = resetSessionScopedState();
    errorReportsIdle = resetResult.errorReportsIdle;
    failedInMemorySurfaces.push(...resetResult.failedSurfaces);
  } catch {
    // The coordinator isolates every registered adapter. Keep this outer boundary so a future
    // regression in its own orchestration still cannot abort Disconnect.
    failedInMemorySurfaces.push('session-reset-coordinator');
  }
  // Revoke live HTTP/socket credential reads synchronously too. SecureStore may hang or reject;
  // neither can be allowed to keep the old account authorized in this JS context.
  try {
    useSessionStore.getState().reset();
  } catch {
    failedInMemorySurfaces.push('session-store');
  }
  try {
    stopReachabilityWatch();
  } catch {
    failedInMemorySurfaces.push('reachability-watch');
  }
  try {
    stopDeviceNetworkWatch();
  } catch {
    failedInMemorySurfaces.push('network-watch');
  }
  let retiringSocket: ReturnType<typeof getSocket> = null;
  try {
    retiringSocket = getSocket();
  } catch {
    failedInMemorySurfaces.push('socket-reference');
  }
  try {
    retiringSocket?.disconnect();
  } catch {
    failedInMemorySurfaces.push('socket-disconnect');
  }
  try {
    setSocket(null);
  } catch {
    failedInMemorySurfaces.push('realtime-runtime');
  }
  if (failedInMemorySurfaces.length > 0) {
    ledger.fail('inMemoryCleanup');
    try {
      logger.warn('[forget] in-memory account cleanup steps failed', {
        surfaces: failedInMemorySurfaces,
      });
    } catch {
      // Logging is best-effort at this boundary; cleanup remains authoritative.
    }
  }
  // Close the authorization window BEFORE the wipe, not after. A sync started at boot can still be
  // paging when the user taps Disconnect, and nothing cancels it — with the credentials still in
  // place its remaining requests stay fully authorized, so `upsertChats`/`upsertMessages` land
  // AFTER the deletes and `fullSync` then writes a non-null marker. Clearing the origin first makes
  // every in-flight request fail immediately (a reset origin builds a relative URL), so the run
  // unwinds in seconds instead of minutes, and it means a Disconnect is honoured even if
  // everything below throws.

  // A previous timed-out destructive chain may still be deleting credentials, a Firebase token,
  // or DB rows. Do not pile another sweep on top of it. The first run already continued all other
  // cleanup; after this exact chain settles, a later run repeats the complete idempotent sweep.
  const priorCleanupQuarantine = lifecycle.accountCleanupQuarantine;
  if (
    priorCleanupQuarantine &&
    !(await withDeadline(priorCleanupQuarantine, ACCOUNT_CLEANUP_JOIN_DEADLINE_MS))
  ) {
    logger.warn('[forget] previous account cleanup operation is still settling');
    throw new Error(ACCOUNT_CLEANUP_QUARANTINE_FAILURE_MESSAGE);
  }

  // A candidate can have one already-issued SecureStore mutation still in native code, regardless
  // of whether it has reached its public timeout. Wait before this sweep so it cannot land behind
  // our deletes. If it misses the bound, keep the marker closed, finish the best-effort wipe, and
  // reject so a later cleanup repeats after it stops.
  const candidateQuarantine = connectCandidateAtRevocation;
  const candidateDrained =
    !candidateQuarantine ||
    (await withDeadline(candidateQuarantine, FOREGROUND_DELIVERY_CLEANUP_DEADLINE_MS));
  if (!candidateDrained) {
    ledger.fail('candidateDrain');
    logger.warn('[forget] timed-out connection candidate is still settling');
  }

  // SecureStore has no multi-key transaction. When the independent marker succeeded, this entire
  // monotonic retirement chain may be bounded: a late delete cannot reactivate A, and quarantine
  // prevents B until it settles plus a fresh full sweep passes. If the marker failed, never race a
  // timer—the vault chain is the only killed-process revocation proof and must remain awaited.
  // Preserve the tuple until the post-drain snapshot proves whether it is server-revocation
  // custody. The `forgotten`/independent marker makes it inactive immediately.
  const credentialRetirement = retireDurableCredentials(independentlyRevoked, true);
  if (independentlyRevoked) {
    const retirement = await settleWithinDeadline(
      credentialRetirement,
      CREDENTIAL_CLEANUP_DEADLINE_MS,
      () => quarantineAccountCleanup(credentialRetirement),
    );
    if (retirement.kind === 'value') {
      if (retirement.value) ledger.fail('durableCredential', retirement.value);
    } else {
      ledger.fail('durableCredential');
      if (retirement.kind === 'timeout') {
        logger.warn('[forget] secure credential retirement timed out');
      } else {
        logger.warn('[forget] secure credential retirement failed unexpectedly', retirement.error);
      }
    }
  } else {
    const failure = await credentialRetirement;
    if (failure) ledger.fail('durableCredential', failure);
  }

  // Firebase registration belongs to the OLD server even though the token itself lives in the
  // Firebase installation, not our DB/vault. Invalidating the installation token makes the token A
  // knows unusable. For a scoped session, the exact server principal is also self-revoked below
  // after tracked registration work drains. Do this after both durable revocation gates are closed,
  // and treat native/import failure as incomplete account cleanup: the local wipe continues, but
  // connect B cannot validate until a retry succeeds.
  if (FCM_ENABLED) {
    const retirement = (async (): Promise<void> => {
      const { deleteToken, getMessaging } = await import('@react-native-firebase/messaging');
      await deleteToken(getMessaging());
    })();
    const result = await settleWithinDeadline(retirement, FCM_TOKEN_RETIREMENT_DEADLINE_MS, () =>
      quarantineAccountCleanup(retirement),
    );
    if (result.kind !== 'value') {
      ledger.fail('fcmTokenRetirement');
      if (result.kind === 'timeout') {
        logger.warn('[forget] previous FCM token retirement timed out');
      } else {
        logger.warn('[forget] previous FCM token retirement failed', result.error);
      }
    }
  }
  const realtimeDrained = await withDeadline(realtimeIdle, REALTIME_DRAIN_DEADLINE_MS);
  if (!realtimeDrained) {
    ledger.fail('realtimeDrain');
    // Admission/generation was invalidated synchronously, but the tracked set now includes whole
    // account actions and scheduled sends that can carry network/DB work. Still perform the sweep;
    // do not authorize B until a later retry proves every old slot idle and wipes once more.
    logger.warn('[forget] realtime delivery drain timed out — next connection remains blocked');
  }

  let scopedCredentialRetirement: Promise<DeadlineSettlement<void>> | null = null;
  if (realtimeDrained && candidateDrained) {
    // SecureStore is not internally serialized. Take the authoritative view only after every
    // tracked adoption writer has settled, and bound the native read independently of the wipe.
    const scopedCredentialSnapshot = captureScopedCredentialRevocationTargets(liveScopedTarget);
    const snapshotResult = await settleWithinDeadline(
      scopedCredentialSnapshot,
      SCOPED_CREDENTIAL_CAPTURE_DEADLINE_MS,
    );
    if (snapshotResult.kind === 'value') {
      // The session is already durably inactive, but its encrypted scoped bearer remains retry
      // custody. Confirm server revocation first; only then erase it and replace the upgrade journal
      // with the keyless terminal marker. Run beside the local data wipe, with a strict outer bound.
      const retirement = finishScopedCredentialRetirement(
        snapshotResult.value,
        true,
        independentlyRevoked,
        waiveRemoteRevocation,
      );
      scopedCredentialRetirement = settleWithinDeadline(
        retirement,
        SCOPED_CREDENTIAL_RETIREMENT_DEADLINE_MS,
        () => quarantineAccountCleanup(retirement),
      );
    } else {
      ledger.fail('credentialUpgradeRetirement');
      logger.warn('[forget] scoped credential snapshot was unavailable', {
        reason: snapshotResult.kind,
        ...(snapshotResult.kind === 'error'
          ? {
              errorName:
                snapshotResult.error instanceof Error ? snapshotResult.error.name : 'UnknownError',
            }
          : {}),
      });
      if (snapshotResult.kind === 'timeout') {
        const lateRetirement = Promise.all([
          scopedCredentialSnapshot,
          credentialRetirement.then((failure) => {
            if (failure) throw failure;
          }),
        ]).then(([lateSnapshot]) =>
          finishScopedCredentialRetirement(
            lateSnapshot,
            true,
            independentlyRevoked,
            waiveRemoteRevocation,
          ),
        );
        quarantineAccountCleanup(lateRetirement);
      }
    }
  } else {
    // A suspended adoption writer or timed-out connection commit could still create new custody.
    // Keep B blocked and take the only authoritative snapshot after both writers and the initial
    // `forgotten` mutation settle. In particular, a late scoped `serverPassword` write must retain
    // its already-written origin long enough for this fixed-client revocation.
    const lateRetirement = Promise.all([
      realtimeIdle,
      candidateQuarantine ?? Promise.resolve(),
      credentialRetirement.then((failure) => {
        if (failure) throw failure;
      }),
    ])
      .then(() => captureScopedCredentialRevocationTargets(liveScopedTarget))
      .then((lateSnapshot) =>
        finishScopedCredentialRetirement(
          lateSnapshot,
          true,
          independentlyRevoked,
          waiveRemoteRevocation,
        ),
      );
    quarantineAccountCleanup(lateRetirement);
    ledger.fail('credentialUpgradeRetirement');
  }

  // Registration owns SecureStore writes and is part of the realtime drain. Retire its key only
  // AFTER that drain succeeds, so a suspended pending/active write cannot resurrect account A's
  // key behind the keyless revoked tombstone. On timeout, skip the mutation; the failed drain
  // blocks B and a later full cleanup retries after all old registration slots have settled.
  if (realtimeDrained) {
    const retirement = retireFcmDeviceEncryptionState(vault);
    const result = await settleWithinDeadline(retirement, FCM_KEY_RETIREMENT_DEADLINE_MS, () =>
      quarantineAccountCleanup(retirement),
    );
    if (result.kind !== 'value') {
      ledger.fail('fcmKeyRetirement');
      if (result.kind === 'timeout') {
        logger.warn('[forget] push encryption-key retirement timed out');
      } else {
        logger.warn('[forget] push encryption-key retirement failed');
      }
    }
  }
  // An admitted send can reach its uploader after the first synchronous sweep. Re-cancel after the
  // account-work barrier, then join exact native tails that outlive their already-rejected public
  // send promise. A timeout leaves those terminal promises registered so the next cleanup retry
  // still blocks B until they settle.
  let uploadsDrained = false;
  try {
    uploadRegistry.cancelAll();
    uploadsDrained = await withDeadline(uploadRegistry.awaitIdle(), UPLOAD_DRAIN_DEADLINE_MS);
  } catch (error) {
    logger.warn('[forget] upload cancellation failed', error);
  }
  if (!uploadsDrained) {
    ledger.fail('uploadDrain');
    logger.warn('[forget] upload drain timed out — next connection remains blocked');
  }
  // …then let that dying run actually finish before we delete anything. Bounded: if a request is
  // wedged we still owe the user the wipe, and by now it can't fetch anything new anyway.
  const syncDrained = await withDeadline(awaitSyncIdle(), SYNC_DRAIN_DEADLINE_MS);
  if (!syncDrained) {
    ledger.fail('syncDrain');
    // HttpClient snapshots A's transport for an in-flight request. Until every sync page commit is
    // generation-guarded, a late response may repopulate A rows after this sweep; keep B blocked so
    // a later cleanup can drain that run and wipe again.
    logger.warn('[forget] sync drain timed out — next connection remains blocked');
  }
  let downloadsDrained = false;
  try {
    const { cancelAndDrainBoundedDownloads } = await import('./download/boundedNativeDownload');
    downloadsDrained = await cancelAndDrainBoundedDownloads(DOWNLOAD_DRAIN_DEADLINE_MS);
  } catch (error) {
    logger.warn('[forget] bounded-download cancellation failed', error);
  }
  if (!downloadsDrained) {
    ledger.fail('downloadDrain');
    logger.warn('[forget] bounded-download drain timed out — next connection remains blocked');
  }
  if (!(await withDeadline(errorReportsIdle, ERROR_REPORT_DRAIN_DEADLINE_MS))) {
    // The old drain's generation is already revoked. Its DB transaction either rolls back or is
    // ordered ahead of the wipe on the shared write queue, so a timeout cannot repopulate the
    // cleared table; it only means Disconnect stops waiting for the diagnostic task itself.
    logger.warn('[forget] error-report drain timed out — continuing with generation revoked');
  }

  // Pull the previous account's notifications out of the tray. A DISPLAYED notification is system
  // state that outlives every row this function is about to delete, and message notifications carry
  // the sender's name, avatar and message body — so without this the wipe destroys the local copy
  // while whoever picks the device up next still reads the content on the lock screen, and the
  // Disconnect dialog has just promised the opposite. Tapping one after reconnecting is worse than
  // useless too: a 1:1 guid is `service;-;address`, byte-identical across servers, so it opens the
  // NEW account's thread with that person (or an empty screen for a chat that does not exist here).
  //
  // cancelAllNotifications rather than a per-chat loop: everything this app has posted belongs to
  // the account being left, and enumerating them would need the DB — which is exactly what may be
  // unavailable. Ahead of the DB block for the same reason, with its own lazy import (notify-kit's
  // native bridge is deliberately kept out of this module's load graph) and its own try/catch. A
  // failure cannot skip the remaining cleanup, but it does keep the next account blocked.
  try {
    const { cancelAllNotifications } = await import('./notifications/notifeeService');
    // Keep the queue ordering: if an older notification mutation is still finishing, this cleanup
    // must remain behind it and ahead of any future account's posts. But a native call can wedge
    // indefinitely, so attach the rejection handler now (preventing a late unhandled rejection)
    // and let the local account wipe continue after a bounded wait.
    let notificationCleanupRejected = false;
    const notificationCleanup = cancelAllNotifications().catch((e: unknown) => {
      notificationCleanupRejected = true;
      logger.warn('[forget] could not clear displayed notifications', e);
    });
    const notificationCleanupCompleted = await withDeadline(
      notificationCleanup,
      NOTIFICATION_CLEAR_DEADLINE_MS,
    );
    if (!notificationCleanupCompleted) {
      logger.warn(
        '[forget] notification cleanup timed out — continuing; queued cleanup remains ordered',
      );
    }
    if (!notificationCleanupCompleted || notificationCleanupRejected) {
      ledger.fail('notificationCleanup');
    }
  } catch (e) {
    ledger.fail('notificationCleanup');
    logger.warn('[forget] could not clear displayed notifications', e);
  }

  // Wipe everything the DB cached FROM this server. Clearing the credentials alone leaves the
  // whole local store intact, so connecting to a DIFFERENT server next shows the previous
  // account's threads interleaved with the new ones — on a shared device, someone else's
  // conversations — and the surviving sync marker sends the next sync down the incremental
  // branch with the OLD server's ROWID cursor. Unconditional: `applyNewServerUrl` legitimately
  // rewrites the origin for the SAME server on a tunnel rotation, so "did the origin change?"
  // is not a usable test. Failure cannot skip later cleanup, but it leaves the account quarantined.
  const databaseCleanup = cleanupAccountDatabase();
  const databaseResult = await settleWithinDeadline(
    databaseCleanup,
    DATABASE_CLEANUP_DEADLINE_MS,
    () => quarantineAccountCleanup(databaseCleanup),
  );
  if (databaseResult.kind === 'value') {
    const { databaseFailure, notificationFailure } = databaseResult.value;
    if (databaseFailure) ledger.fail('databaseCleanup', databaseFailure);
    // The tray sweep above keeps its own failure; only an otherwise clean notification step adopts
    // the one the DB cleanup reports.
    if (notificationFailure && !ledger.failed('notificationCleanup')) {
      ledger.fail('notificationCleanup', notificationFailure);
    }
  } else {
    ledger.fail('databaseCleanup');
    if (databaseResult.kind === 'timeout') {
      logger.warn('[forget] local cache wipe timed out; late work remains quarantined');
    } else {
      logger.warn('[forget] local cache wipe failed unexpectedly', databaseResult.error);
    }
  }
  const mediaCleared = await deleteCachedMedia();
  if (!mediaCleared) ledger.fail('mediaCleanup');
  // Confirm both legacy and current Direct Share cleanup before allowing account B. The native
  // operation also rotates the opaque-id namespace so a retained account-A target cannot resolve
  // under B. Lazy import keeps the native bridge off the bootstrap graph until teardown.
  try {
    const { clearAllShareShortcuts } = await import('./shortcuts/shareShortcuts');
    if (!clearAllShareShortcuts()) {
      ledger.fail('shortcutCleanup');
      logger.warn('[forget] could not confirm Direct Share shortcut cleanup');
    }
  } catch (e) {
    ledger.fail('shortcutCleanup');
    logger.warn('[forget] could not clear Direct Share shortcuts', e);
  }

  // The local credential/database/media wipe above ran independently of server availability.
  // Consume only the bounded retirement result now. A failure leaves the exact bearer encrypted
  // under `forgotten`, so the next cleanup can retry instead of orphaning live server authority.
  let onlyServerStepUnconfirmed = false;
  if (scopedCredentialRetirement) {
    const result = await scopedCredentialRetirement;
    if (result.kind !== 'value') {
      ledger.fail('credentialUpgradeRetirement');
      // Its own error type means the server step failed before any local custody step ran.
      onlyServerStepUnconfirmed =
        result.kind === 'error' && result.error instanceof ScopedCredentialServerRevocationError;
      const error =
        result.kind !== 'error'
          ? undefined
          : result.error instanceof ScopedCredentialServerRevocationError
            ? result.error.serverError
            : result.error;
      logger.warn('[forget] scoped credential self-revocation was not confirmed', {
        reason: result.kind,
        ...(result.kind === 'error'
          ? {
              errorName: error instanceof Error ? error.name : 'UnknownError',
            }
          : {}),
      });
    }
  }

  // Logs are account-scoped diagnostics too. Clear them LAST, after every cleanup step that can
  // log, then attempt at most a generic development-only warning after the buffer reset. Bound
  // native filesystem I/O so the local wipe cannot hang forever; an incomplete clear keeps B
  // blocked and is retried on connect.
  let persistedLogsCleared = false;
  let logClearError: unknown;
  const persistentLogClear = fileLogSink
    .clear()
    .then((clearedLogs) => {
      persistedLogsCleared = clearedLogs;
    })
    .catch((error: unknown) => {
      logClearError = error;
    });
  const logClearCompleted = await withDeadline(persistentLogClear, LOG_CLEAR_DEADLINE_MS);
  memoryLogSink.clear();
  if (!(logClearCompleted && persistedLogsCleared)) ledger.fail('logCleanup');

  // The caller must not mistake a completed local wipe for a fully retired account. Marker and
  // tombstone stay closed; connect() sees this rejection, reports it, and retries the whole
  // idempotent cleanup before validating B. Any development log happens only AFTER A's buffers reset.
  const cleanupFailure = ledger.firstFailure();
  if (cleanupFailure) {
    logger.warn('[forget] account cleanup remains incomplete; next connection will retry', {
      reason: cleanupFailure.message,
      ...(logClearError === undefined
        ? {}
        : { logError: logClearError instanceof Error ? logClearError.name : 'UnknownError' }),
    });
    // Startup may show setup only when the server's revocation is the one unfinished step and the
    // vault itself reads `forgotten` (a failed tombstone write leaves only the marker file).
    const onlyServerRevocationPending =
      onlyServerStepUnconfirmed &&
      ledger.isOnlyFailure('credentialUpgradeRetirement') &&
      (await sessionTombstoneConfirmed());
    throw onlyServerRevocationPending ? new ServerRevocationPendingError() : cleanupFailure;
  }
  // Only a user-triggered invalidation needs an out-of-band proof for the successor coordinator.
  // An internal caller is already awaiting this exact outcome and must not leave a reusable hint.
  lifecycle.lastSuccessfulForgetEpoch = invalidateForegroundBoot ? forgetEpoch : -1;
}
/** How many times `forget()` will run the wipe before giving up (see {@link wipeLocalCache}). */
const WIPE_ATTEMPTS = 2;
/**
 * Run the local wipe and CONFIRM it, re-running once if rows survived.
 *
 * `clearLocalCache` is a sequence of independent autocommit statements, each fenced through the
 * process-wide write queue. It cannot be one SQL transaction for the seconds it may take to delete
 * every message (see its own note). A partial wipe is still reachable: the process can die between
 * statements, or an ordinary writer not yet migrated to the queue can interleave rows. Either way
 * the previous account's conversations remain on the device — the exact leak Disconnect exists to
 * close. The separately queue-fenced residue read prevents a neighbouring transaction's temporary
 * empty view from being accepted as clean.
 *
 * A second pass fixes both: whatever raced the first one has stopped by then (the authorization
 * window is closed and durable session state is retired or its failure was logged), and the wipe is
 * idempotent. Anything still dirty after that makes the wipe fail closed: the tombstone stays in
 * place and a later boot/connect retries before it can authorize another account.
 */
async function wipeLocalCache(db: ReadDb): Promise<boolean> {
  for (let attempt = 1; attempt <= WIPE_ATTEMPTS; attempt++) {
    try {
      await clearLocalCache(db);
    } catch (e) {
      logger.warn(`[forget] local cache wipe attempt ${attempt} failed`, e);
    }
    if (!(await localCacheDirty(db))) return true;
    logger.warn(`[forget] local cache still populated after wipe attempt ${attempt}`);
  }
  return false;
}
type ForgetOutcome = { ok: true } | { ok: false; error: unknown };
export interface ForgetRun {
  /** The real public result, including a credential-removal rejection. */
  run: Promise<void>;
  /** A non-rejecting view used by boot/connect coordination. */
  outcome: Promise<ForgetOutcome>;
  /** A user-visible Disconnect needs a successor that joins this published cleanup. */
  restartForegroundBoot: boolean;
  restartDispatched: boolean;
  restartAccepted: boolean;
}
function dispatchForgetRestart(run: ForgetRun): void {
  if (!run.restartForegroundBoot || run.restartDispatched) return;
  run.restartDispatched = true;
  run.restartAccepted = restartForegroundBootAfterAccountTransition();
}
/**
 * Forget the connection (see {@link runForget}), publishing the run so `connect()` can wait it out.
 *
 * The tracked promise is a NON-REJECTING view of the run: waiters only need to know the wipe has
 * stopped, and parking a rejecting promise in a module slot that nobody awaits would surface as an
 * unhandled rejection. The caller still receives the real promise, with the real error.
 */
function startForget(
  invalidateForegroundBoot: boolean,
  waiveRemoteRevocation = false,
): Promise<void> {
  // Public Disconnect owns the user's intent even when Connect has not reached candidate
  // validation/captured lifecycle.connectionAttemptEpoch yet. Internal residual cleanup belongs to that
  // same Connect and must not revoke it, so only the public path calls this hook.
  if (invalidateForegroundBoot) lifecycle.activeConnectRevoker?.();
  // Disconnect may be triggered twice by rapid UI/native events. Starting two idempotent wipes is
  // still unsafe: the second can finish first, connect B can clear the marker, and the slower first
  // can then delete B's freshly synced rows. Every caller therefore shares one underlying run.
  if (lifecycle.forgetInFlight) {
    if (invalidateForegroundBoot && !lifecycle.forgetInFlight.restartForegroundBoot) {
      lifecycle.forgetInFlight.restartForegroundBoot = true;
      invalidateForegroundBootForAccountTransition();
      dispatchForgetRestart(lifecycle.forgetInFlight);
    }
    return lifecycle.forgetInFlight.run;
  }

  // Publish a deferred public promise BEFORE invoking runForget. Its pre-await work deliberately
  // calls native cancel handles, store subscribers and socket.disconnect(); any one of those may
  // synchronously re-enter this function and must observe/share this exact run rather than starting
  // a second wipe in the tiny window before runForget reaches SecureStore.
  let resolveRun!: () => void;
  let rejectRun!: (error: unknown) => void;
  const run = new Promise<void>((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });
  let tracked!: ForgetRun;
  const outcome: Promise<ForgetOutcome> = run
    .then<ForgetOutcome, ForgetOutcome>(
      () => ({ ok: true }),
      (error: unknown) => ({ ok: false, error }),
    )
    .then((result) => {
      // An internally-started cleanup can later be promoted by a public Disconnect. Preserve the
      // exact successful epoch for its already-dispatched successor in that case too.
      if (result.ok && tracked.restartForegroundBoot && tracked.restartAccepted) {
        lifecycle.lastSuccessfulForgetEpoch = lifecycle.connectionAttemptEpoch;
      }
      return result;
    })
    .finally(() => {
      if (lifecycle.forgetInFlight?.run === run) lifecycle.forgetInFlight = null;
      if (tracked.restartForegroundBoot && !tracked.restartAccepted) {
        // Headless/tests may load teardown without the foreground singleton. Do not let a proof
        // intended for its immediate successor leak into an unrelated later lifecycle.
        lifecycle.lastSuccessfulForgetEpoch = -1;
      }
    });
  tracked = {
    run,
    outcome,
    restartForegroundBoot: invalidateForegroundBoot,
    restartDispatched: false,
    restartAccepted: false,
  };
  lifecycle.forgetInFlight = tracked;
  const cleanup = runForget(invalidateForegroundBoot, waiveRemoteRevocation);
  // `runForget` executes synchronously through epoch revocation, coordinator invalidation, account
  // admission closure, and its first durable mutation before yielding this Promise. Starting the
  // successor now is therefore safe; its session adapter sees `lifecycle.forgetInFlight` and joins this run.
  dispatchForgetRestart(tracked);
  void cleanup.then(resolveRun, rejectRun);
  return run;
}
export function forget(): Promise<void> {
  return startForget(true);
}
/**
 * "Forget on this phone only" for a previous server that cannot confirm revoking this phone's scoped
 * credential (gone, unreachable, reinstalled offline). Runs the same full Disconnect wipe but skips
 * the server revoke-self step, so the retained bearer is erased from this phone and new connections
 * unblock. The old server may keep listing this phone until it is removed there; callers must say so
 * before the user confirms. Waits out any running cleanup first, so the waiver applies only to a
 * fresh run and never shortcuts one already in flight.
 */
export async function forgetOnThisPhoneOnly(): Promise<void> {
  while (lifecycle.forgetInFlight) await awaitForgetIdle();
  return startForget(true, true);
}
/**
 * True while a previous server still has to confirm revoking this phone's access: Disconnect left
 * the vault `forgotten` with a scoped bearer kept as retry custody, in the saved pair, an unfinished
 * upgrade journal or a replaced-bearer record. It reads the same snapshot the cleanup revokes, so
 * setup's Welcome screen offers "Forget on this phone only" up front exactly when a connection
 * would be refused for it. Any read failure reports false; connect() still refuses in that state.
 */
export async function previousServerRevocationPending(): Promise<boolean> {
  try {
    if ((await vault.get('serverSessionState')) !== SERVER_SESSION_STATE.forgotten) return false;
    const { targets } = await captureScopedCredentialRevocationTargets(null);
    return targets.length > 0;
  } catch {
    return false;
  }
}
/** The server a retained, unrevoked scoped credential belongs to, for confirmation text only. */
export async function previousUnrevokedServerOrigin(): Promise<string | null> {
  try {
    return strictServerOrigin(await vault.get('serverAddress'));
  } catch {
    return null;
  }
}
/** Resolve with a running wipe's outcome, or null when none was active. Never rejects. */
export async function awaitForgetIdle(): Promise<ForgetOutcome | null> {
  const running = lifecycle.forgetInFlight;
  return running ? await running.outcome : null;
}
/** Join the current wipe or start one, preserving its real outcome for fail-closed callers. */
export async function runOrAwaitForget(): Promise<ForgetOutcome> {
  const running = lifecycle.forgetInFlight;
  if (running) return running.outcome;
  try {
    await startForget(false);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
/**
 * Directories under the app's DOCUMENTS dir that mirror server content (or are pinned to a chat
 * guid). `clearLocalCache` deletes the rows that hold their paths, so every byte left here is
 * unreachable by any code path — on an auto-download account that is gigabytes of photos only
 * "Clear app data" could ever reclaim, and the Disconnect confirmation promises they go.
 *
 * `app-logs.json` is cleared separately as the FINAL wipe step through `FileLogSink`, so it is not
 * listed here. Anything under `Paths.cache` is OS-reclaimable, and backup/share staging owns its
 * own deletion lifecycle.
 */
const WIPED_MEDIA_DIRS = [
  'attachments', // downloadService → expoFetcher
  'server-contact-avatars', // backfillServerAvatars
  'synced-backgrounds', // syncedBackground
  'group-photos', // groupPhotos
  'video-posters', // videoPosters (Shared Media video stills)
  'live-photo-clips', // livePhotoClips (Live Photo motion clips)
  'chat-bg', // the user's own per-chat wallpaper picks — their chat rows go with the wipe
] as const;
/**
 * Confirmed removal of the on-disk media the wipe just orphaned. Its own function (and its own
 * try/catch per directory) because expo-file-system is a native module: the lazy import keeps it
 * out of this module's node-test load graph. A failure does not skip later cleanup, but it keeps a
 * new account blocked. Bounded downloads are cancelled and drained before this final sweep, so a
 * late old-account promotion cannot recreate one of these directories after removal.
 */
async function deleteCachedMedia(): Promise<boolean> {
  let cleared = true;
  try {
    const { Directory, Paths } = await import('expo-file-system');
    for (const name of WIPED_MEDIA_DIRS) {
      try {
        const dir = new Directory(Paths.document, name);
        if (dir.exists) dir.delete();
        if (dir.exists) {
          cleared = false;
          logger.warn(`[forget] cached media dir ${name} still exists after delete`);
        }
      } catch (e) {
        cleared = false;
        logger.warn(`[forget] could not delete cached media dir ${name}`, e);
      }
    }
  } catch (e) {
    cleared = false;
    logger.warn('[forget] filesystem unavailable — cached media left on disk', e);
  }
  return cleared;
}
/** How long `forget()` waits for a dying sync before wiping anyway (see the call site). */
const SYNC_DRAIN_DEADLINE_MS = 20_000;
/** Join a previously quarantined destructive chain briefly; restart is required if it stays hung. */
const ACCOUNT_CLEANUP_JOIN_DEADLINE_MS = 5_000;
/** The filesystem revocation marker makes a late monotonic SecureStore retirement safe to quarantine. */
const CREDENTIAL_CLEANUP_DEADLINE_MS = 5_000;
/** Reading encrypted retry custody cannot be allowed to strand the local privacy wipe. */
const SCOPED_CREDENTIAL_CAPTURE_DEADLINE_MS = 5_000;
/** Abort each server self-revocation promptly; 403/5xx remain unconfirmed and retryable. */
const SCOPED_SELF_REVOKE_DEADLINE_MS = 5_000;
/** Outer bound covers remote abort plus the final SecureStore tombstone/delete operations. */
const SCOPED_CREDENTIAL_RETIREMENT_DEADLINE_MS =
  SCOPED_SELF_REVOKE_DEADLINE_MS + CREDENTIAL_CLEANUP_DEADLINE_MS;
/** A late token delete could retire account B's token, so it remains quarantined after this bound. */
const FCM_TOKEN_RETIREMENT_DEADLINE_MS = 5_000;
/** A late tombstone write could retire account B's key, so it remains quarantined after this bound. */
const FCM_KEY_RETIREMENT_DEADLINE_MS = 5_000;
/** DB open + reminder retirement + confirmed stable-view repair may be slow, but never unbounded. */
const DATABASE_CLEANUP_DEADLINE_MS = 30_000;
/** Realtime work is DB/native presentation only; long downloads run outside this drain. */
const REALTIME_DRAIN_DEADLINE_MS = 5_000;
/** Native cancellation should be prompt; a wedged transfer keeps the next account blocked. */
const DOWNLOAD_DRAIN_DEADLINE_MS = 5_000;
/** Native upload cancellation can resolve publicly before Expo's exact transfer promise settles. */
const UPLOAD_DRAIN_DEADLINE_MS = 5_000;
/** Error capture uses a short DB transaction; a wedge must not make Disconnect wait forever. */
const ERROR_REPORT_DRAIN_DEADLINE_MS = 5_000;
/** Native notification work is ordered, but a wedged bridge must not block the local wipe forever. */
const NOTIFICATION_CLEAR_DEADLINE_MS = 5_000;
/** Persistent logs are filesystem-backed; a wedged bridge must leave the account revoked. */
const LOG_CLEAR_DEADLINE_MS = 5_000;
/** Re-read of the vault's `forgotten` tombstone before startup may show setup (Disconnect fix). */
const SESSION_TOMBSTONE_CHECK_DEADLINE_MS = 5_000;

/**
 * The wipe steps `forget()` awaits one after another, each bounded by its own deadline. Add a new
 * sequential step here so the boot join below keeps covering the whole wipe. (The scoped server
 * self-revocation runs alongside these steps and adds no time.)
 */
const SEQUENTIAL_WIPE_STEP_DEADLINES_MS = [
  ACCOUNT_CLEANUP_JOIN_DEADLINE_MS,
  FOREGROUND_DELIVERY_CLEANUP_DEADLINE_MS,
  CREDENTIAL_CLEANUP_DEADLINE_MS,
  FCM_TOKEN_RETIREMENT_DEADLINE_MS,
  REALTIME_DRAIN_DEADLINE_MS,
  SCOPED_CREDENTIAL_CAPTURE_DEADLINE_MS,
  FCM_KEY_RETIREMENT_DEADLINE_MS,
  UPLOAD_DRAIN_DEADLINE_MS,
  SYNC_DRAIN_DEADLINE_MS,
  DOWNLOAD_DRAIN_DEADLINE_MS,
  ERROR_REPORT_DRAIN_DEADLINE_MS,
  NOTIFICATION_CLEAR_DEADLINE_MS,
  DATABASE_CLEANUP_DEADLINE_MS,
  LOG_CLEAR_DEADLINE_MS,
  SESSION_TOMBSTONE_CHECK_DEADLINE_MS,
] as const;
/** Room for the wipe's untimed work, such as deleting cached files and loading modules. */
const WIPE_UNTIMED_WORK_MARGIN_MS = 40_000;
/**
 * How long a restarted foreground boot may wait for a Disconnect wipe it joins (review M120): the
 * whole bounded wipe plus margin (155 s today). The boot's 10 s session deadline used to fire
 * first and showed "Couldn't start Gator" for a Disconnect that was still finishing normally.
 */
export const ACCOUNT_CLEANUP_BOOT_JOIN_DEADLINE_MS =
  SEQUENTIAL_WIPE_STEP_DEADLINES_MS.reduce((total, ms) => total + ms, 0) +
  WIPE_UNTIMED_WORK_MARGIN_MS;
