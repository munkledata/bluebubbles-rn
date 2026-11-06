/** Outgoing recovery of the send front door (moved from index.ts): queue health, recovery after a restart, manual retry and discard. */

import { logger } from '@core/secure';
import {
  currentRcsProviderEpoch,
  isCurrentRcsChatGuid,
  isCurrentRcsMessageGuid,
} from '@core/rcs/providerIdentity';
import { getDatabase } from '@db/database';
import {
  claimFailedOutgoingForRetryWithinTransaction,
  countOutgoingQueueHealth,
  deleteMessageLocalWithinTransaction,
  discardOutgoingMessageWithinTransaction,
  getOutgoingRetryChatGuid,
  imessagePlainTextQueueState,
  MessageTargetCapabilityUnknownError,
  reconcileOutgoingError,
  resolveServerSendErrorOwnersWithinTransaction,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import { useSessionStore } from '@state/sessionStore';
import { isRcsChatGuid } from '@utils/chat';
import { accountHttp } from '../clients';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';
import { uploadRegistry } from './uploadControl';
import { resendOutgoingRow, runOutgoingQueue } from './outgoingQueueService';
import { createAttachmentCacheAccountScope } from '../download/attachmentCacheAccountScope';
import { attachmentCacheCoordinator } from '../download/attachmentCacheCoordinator';
import { clearFailedSendNotice } from './sendFailureNotice';
import {
  captureSessionRcsCapabilityLease,
  messageTargetCommitGuard,
  messageTargetServerAuthorization,
} from './rcsAttemptCapability';
import { outgoingQueueIO, runUiAccountOperation } from './sendShared';

export type ManualRetryResult =
  | 'retried'
  | 'already-sending'
  | 'already-settled'
  | 'unretryable'
  | 'unsendable'
  | 'failed'
  | 'stale';
export type DiscardMessageResult = 'discarded' | 'message-changed' | 'stale';
/**
 * Once per JS context: report optimistic sends whose message row and queue row lost each other.
 * The windows that can produce either half are single-digit milliseconds wide, so the only way to
 * learn whether they happen in the wild is to count them on real devices. Best-effort and silent
 * when clean — a diagnostic must never break the drain it rides on.
 */
let queueHealthReported = false;
async function reportQueueHealthOnce(): Promise<void> {
  if (queueHealthReported) return;
  queueHealthReported = true;
  try {
    const health = await countOutgoingQueueHealth(getDatabase());
    if (health.strandedSending > 0 || health.orphanQueueRows > 0) {
      logger.warn(
        `[queue] orphaned optimistic sends: ${health.strandedSending} stuck 'sending' with no queue row, ${health.orphanQueueRows} queue rows with no message`,
      );
    }
  } catch (e) {
    logger.debug('[queue] health check failed', e);
  }
}
/**
 * Retry stranded/failed queued sends with backoff (the optimistic-send recovery).
 * Run at launch and from the background task — a crash mid-send no longer strands a
 * message; it retries automatically until it sends or retires to the error bubble.
 */
export async function recoverOutgoing(
  now = Date.now(),
): Promise<{ eligible: number; sent: number }> {
  // Capture before the health-check await. An old recovery callback must never turn into a B-account
  // drain merely because Disconnect + reconnect completed while that read was in flight.
  const accountLease = captureRealtimeDeliveryLease();
  if (!accountLease.isCurrent()) return { eligible: 0, sent: 0 };
  // Before the drain, so the counts describe what the last session left behind rather than what
  // this one just repaired. Gated to the first call, which is the boot drain.
  await reportQueueHealthOnce();
  const capability = captureSessionRcsCapabilityLease();
  const serverAuthorization = messageTargetServerAuthorization(
    capability?.serverInfo,
    () => accountLease.isCurrent() && capability?.isCurrent() === true,
  );
  const rcsAvailable = (chatGuid?: string, messageGuid?: string): boolean => {
    const info = capability?.serverInfo;
    return (
      accountLease.isCurrent() &&
      capability?.isCurrent() === true &&
      currentRcsProviderEpoch(info) !== null &&
      (chatGuid === undefined || isCurrentRcsChatGuid(info, chatGuid)) &&
      (messageGuid === undefined || isCurrentRcsMessageGuid(info, messageGuid))
    );
  };
  const locationAvailable = (): boolean =>
    accountLease.isCurrent() &&
    capability?.isCurrent() === true &&
    capability.serverInfo?.supports_imessage_location === true;
  const imessagePlainTextAvailable = (chatGuid?: string): boolean =>
    accountLease.isCurrent() &&
    capability?.isCurrent() === true &&
    capability.serverInfo?.supports_imessage_plain_text === true &&
    (chatGuid === undefined || /^(?:iMessage|any);-;.+$/u.test(chatGuid));
  return runOutgoingQueue(
    getDatabase(),
    accountHttp(accountLease),
    outgoingQueueIO,
    now,
    accountLease,
    undefined,
    undefined,
    serverAuthorization,
    rcsAvailable,
    undefined,
    locationAvailable,
    undefined,
    imessagePlainTextAvailable,
  );
}
/**
 * Retry a failed send: take the errored row over, then drive ONE re-POST of its queue payload.
 *
 * THE SEND IS REBUILT FROM THE QUEUE ROW, NOT FROM THE BUBBLE, and it keeps its ORIGINAL temp guid.
 * The old shape — delete the row, then re-send whatever the sheet could see — got both halves
 * wrong. It re-sent the bubble's TEXT whatever had actually been queued, so a failed CONTACT CARD
 * was delivered as a plain message reading the contact's display name (exactly what `kind:'contact'`
 * exists to prevent), and a failed reply/effect/subject/mention send silently lost those fields;
 * only the payload carries them, and the automatic drain has always used it. And the fresh temp id
 * is the key the server's idempotency cache is built on, so a send that failed client-side (a 30 s
 * HTTP timeout) yet landed server-side went out a SECOND time. Nothing is destroyed either, so a
 * throw in the re-send can no longer leave the user with neither a bubble nor a queue row.
 *
 * The claim is guarded because this button races the automatic retry the app runs every 20 s: that
 * drain leases the same row, flips the bubble to 'sending' and starts a POST that can run for
 * seconds (a foreground attachment upload has no timeout), while the sheet the user is tapping opened
 * before any of that. Only an 'error' row with a live ladder is ours; anything else says so and
 * re-sends nothing.
 */
export async function retry(
  tempGuid: string,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<ManualRetryResult> {
  if (!accountLease.isCurrent()) return 'stale';
  // NEVER rejects. UI callers map this typed result to presentation; a rejection from a press
  // handler would bypass that mapping and become an unhandled promise. The bubble and its ladder
  // survive any failure, so there is nothing to repair — only an outcome to report.
  try {
    const result = await runUiAccountOperation(
      accountLease,
      async (): Promise<ManualRetryResult> => {
        const db = getDatabase();
        const capability = captureSessionRcsCapabilityLease();
        const serverAuthorization = messageTargetServerAuthorization(
          capability?.serverInfo,
          () => accountLease.isCurrent() && capability?.isCurrent() === true,
        );
        const rcsAvailable = (chatGuid?: string, messageGuid?: string): boolean => {
          const info = capability?.serverInfo;
          return (
            accountLease.isCurrent() &&
            capability?.isCurrent() === true &&
            currentRcsProviderEpoch(info) !== null &&
            (chatGuid === undefined || isCurrentRcsChatGuid(info, chatGuid)) &&
            (messageGuid === undefined || isCurrentRcsMessageGuid(info, messageGuid))
          );
        };
        const locationAvailable = (): boolean =>
          accountLease.isCurrent() &&
          capability?.isCurrent() === true &&
          capability.serverInfo?.supports_imessage_location === true;
        const imessagePlainTextAvailable = (chatGuid?: string): boolean =>
          accountLease.isCurrent() &&
          capability?.isCurrent() === true &&
          capability.serverInfo?.supports_imessage_plain_text === true &&
          (chatGuid === undefined || /^(?:iMessage|any);-;.+$/u.test(chatGuid));
        const retryChatGuid = await getOutgoingRetryChatGuid(db, tempGuid);
        if (!accountLease.isCurrent()) return 'stale';
        if (retryChatGuid && isRcsChatGuid(retryChatGuid) && !rcsAvailable(retryChatGuid)) {
          return 'unretryable';
        }
        const { claim, row, attemptOwnerToken } = await withDbTransaction(
          db,
          (db, context) =>
            claimFailedOutgoingForRetryWithinTransaction(
              context,
              tempGuid,
              Date.now,
              serverAuthorization,
              locationAvailable,
              (chatGuid) => rcsAvailable(chatGuid),
              (chatGuid) => imessagePlainTextAvailable(chatGuid),
            ),
          messageTargetCommitGuard(
            () =>
              accountLease.isCurrent() &&
              (!retryChatGuid || !isRcsChatGuid(retryChatGuid) || rcsAvailable(retryChatGuid)),
            serverAuthorization,
          ),
        );
        if (!accountLease.isCurrent()) return 'stale';
        if (claim !== 'claimed' || !row) {
          return claim === 'sending'
            ? 'already-sending'
            : claim === 'settled'
              ? 'already-settled'
              : 'unretryable';
        }
        // The same attempt the drain would make — same payload, same temp guid, same reconcile.
        const outcome = await resendOutgoingRow(
          db,
          accountHttp(accountLease),
          outgoingQueueIO,
          row,
          () => Date.now(),
          accountLease,
          undefined,
          attemptOwnerToken,
          serverAuthorization,
          rcsAvailable,
          undefined,
          locationAvailable,
          imessagePlainTextAvailable,
        );
        if (!accountLease.isCurrent()) return 'stale';
        // Retired for good: the attachment's on-disk file is gone, so no re-send can ever work. The
        // bubble keeps its error badge (Delete on the sheet still works) — say why rather than leave
        // the tap looking like it did nothing.
        switch (outcome) {
          case 'sent':
            return 'retried';
          case 'failed':
            return 'failed';
          case 'unsendable':
            return 'unsendable';
          case 'paused':
            return 'stale';
          case 'deferred': {
            const retrySafePlainText =
              imessagePlainTextQueueState(row.kind, row.payload) === 'retry-safe';
            await reconcileOutgoingError(
              db,
              row.tempGuid,
              1,
              Date.now(),
              () => accountLease.isCurrent(),
              retrySafePlainText
                ? 'Narrow iMessage delivery is temporarily unavailable.'
                : row.kind === 'location'
                  ? 'Current-location sharing is unavailable.'
                  : 'RCS is unavailable.',
              attemptOwnerToken,
              retrySafePlainText,
            );
            return 'failed';
          }
        }
      },
    );
    return result ?? 'stale';
  } catch (e) {
    // Disconnect may have revoked this retry while a DB/native await was in flight. An A-account
    // failure must not surface as a toast in B's newly connected UI (or as a misleading warning).
    if (!accountLease.isCurrent()) return 'stale';
    if (
      e instanceof MessageTargetCapabilityUnknownError ||
      e instanceof DbCommitGuardRejectedError
    ) {
      return 'failed';
    }
    // A DB/driver failure in the claim itself. The automatic ladder still owns the row.
    logger.warn('[send] manual retry failed', e);
    return 'failed';
  }
}
/**
 * Discard a message from the user's "Delete" (single or bulk), whatever state it is in.
 *
 * ONE guarded transaction with two branches covers every state exactly once:
 *  1. `discardOutgoingMessageWithinTransaction` claims ONLY an unconfirmed optimistic row (a `temp-` guid still
 *     'sending' or 'error'): it tombstones the bubble and takes its queue row with it, so the
 *     retry ladder can't re-POST what the user just removed.
 *  2. Everything else — a real server guid, and a `temp-` row already flipped to 'sent' by a
 *     guid-less ack (RCS / AppleScript) — falls through to
 *     `deleteMessageLocalWithinTransaction` before the same commit.
 * BOTH steps tombstone; the difference is only which one owns the queue row and the ownership
 * answer the caller gets. Every state here is a message the server may still have, and a hard
 * delete of any of them is undone the next time the thread syncs (`ensureChatSynced` re-pages 500
 * messages on EVERY chat open) — `date_deleted` is the only thing that survives that.
 * The step-1 helper returning "I cleaned something up" instead of "I own this message" is what
 * made a Delete silently do nothing, so it now reports ownership only.
 */
export async function discardMessage(
  guid: string,
  now: number = Date.now(),
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<DiscardMessageResult> {
  const outcome = await runUiAccountOperation(accountLease, async () => {
    const db = getDatabase();
    const ownerResolution = await withDbTransaction(
      db,
      (db, context) => resolveServerSendErrorOwnersWithinTransaction(context, [guid]),
      () => accountLease.isCurrent(),
    );
    if (!accountLease.isCurrent()) return 'stale';
    if (ownerResolution.hasConflict || ownerResolution.chatGuids.length > 1) {
      return 'message-changed';
    }
    const ownerChatGuid = ownerResolution.chatGuids[0] ?? null;
    const ownerIsRcs = ownerChatGuid?.startsWith('RCS;-;') === true;
    const messageIsRcs = guid.startsWith('rcs-');
    const expectedRcsEpoch =
      ownerIsRcs || messageIsRcs
        ? currentRcsProviderEpoch(useSessionStore.getState().serverInfo)
        : null;
    const rcsIdentityIsCurrent = (): boolean =>
      (!ownerIsRcs ||
        (expectedRcsEpoch != null &&
          currentRcsProviderEpoch(useSessionStore.getState().serverInfo) === expectedRcsEpoch &&
          ownerChatGuid != null &&
          isCurrentRcsChatGuid(useSessionStore.getState().serverInfo, ownerChatGuid))) &&
      (!messageIsRcs || isCurrentRcsMessageGuid(useSessionStore.getState().serverInfo, guid)) &&
      (!messageIsRcs || ownerIsRcs);
    if (!rcsIdentityIsCurrent()) return 'message-changed';
    // STOP THE BYTES FIRST, before either tombstone. "Cancel Sending" used to be a pure DB write:
    // the bubble vanished while the phone carried on streaming the entire file to the server — on a
    // large video, for minutes, over the user's data. The upload simply had no cancel handle to
    // reach for. Cancelling is safe for every other message kind too: nothing is registered under a
    // text/reaction/contact temp guid, so this is a no-op for them.
    uploadRegistry.cancel(guid);
    const attachmentCacheScope = createAttachmentCacheAccountScope(accountLease);
    const transactionResult = await withDbTransaction(
      db,
      async (db, context) => {
        const currentOwner = await resolveServerSendErrorOwnersWithinTransaction(context, [guid]);
        if (
          currentOwner.hasConflict ||
          currentOwner.chatGuids.length !== ownerResolution.chatGuids.length ||
          (currentOwner.chatGuids[0] ?? null) !== ownerChatGuid ||
          !rcsIdentityIsCurrent()
        ) {
          return { kind: 'identity-changed' as const };
        }
        const outgoingOwned = await discardOutgoingMessageWithinTransaction(context, guid, now);
        const result = outgoingOwned
          ? null
          : await deleteMessageLocalWithinTransaction(context, guid, now);
        return { kind: 'applied' as const, result };
      },
      () => accountLease.isCurrent() && rcsIdentityIsCurrent(),
    );
    if (transactionResult.kind === 'identity-changed') return 'message-changed';
    const result = transactionResult.result;
    if (!accountLease.isCurrent() || !rcsIdentityIsCurrent()) return 'stale';
    // The fixed-size alias ledger may have retired an extremely old mapping. Never claim the
    // destructive action succeeded against an identity we cannot prove; the reactive list now
    // carries the real GUID, so selecting the message again gives the user a safe retry.
    const disposition: DiscardMessageResult =
      result === 'unresolved-temp' ? 'message-changed' : 'discarded';
    if (!accountLease.isCurrent() || !rcsIdentityIsCurrent()) return 'stale';
    // The tombstone commits before native mutation. Failed-send notices are keyed by the retained
    // local message id, so removing the bubble must also withdraw its already-posted tray record.
    await clearFailedSendNotice(db, guid, () => accountLease.isCurrent() && rcsIdentityIsCurrent());
    if (!accountLease.isCurrent() || !rcsIdentityIsCurrent()) return 'stale';
    // Tombstone + ledger/ref changes committed above. Exact native deletion stays outside their DB
    // transaction and inside this account-scoped operation, so Disconnect drains it before wipe.
    await attachmentCacheCoordinator
      .retireInactiveEntries(db, { scope: attachmentCacheScope })
      .catch((error) => logger.debug('[send] deleted-message cache retirement deferred', error));
    await attachmentCacheCoordinator
      .drainDueRetirements(db, { scope: attachmentCacheScope })
      .catch((error) => logger.debug('[send] deleted-message cache cleanup deferred', error));
    return disposition;
  });
  return outcome ?? 'stale';
}
