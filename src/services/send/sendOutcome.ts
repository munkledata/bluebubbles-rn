import type { SendAck } from '@core/api/endpoints/messages';
import { ApiError } from '@core/api/errors';
import { logger } from '@core/secure';
import { ClientErrorCode, sendErrorCode } from '@utils';
import {
  markOutgoingSentNoGuidWithinTransaction,
  reconcileOutgoingAttemptAckWithinTransaction,
  reconcileOutgoingErrorWithinTransaction,
  reconcileOutgoingSuccessWithinTransaction,
  retireOutgoingWithinTransaction,
  type OutgoingAckDisposition,
  type SendAttemptOwnerToken,
} from '@db/repositories';
import { withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { clearFailedSendNotice, notifyFailedSend } from './sendFailureNotice';

export interface SendOutcomeOptions {
  /** Fixed disposable harnesses suppress OS presentation while retaining the full DB outcome. */
  readonly failureNoticeMode?: 'enabled' | 'suppressed';
  /** Exact local request generation captured before an attempt-aware RCS request began. */
  readonly attemptOwnerToken?: SendAttemptOwnerToken;
}

/**
 * Permanently retire an optimistic send whose exact reply/action target is no longer available.
 * This is a local policy refusal, not a transport failure: never feed it into the retry backoff.
 */
export function retireUnavailableMessageTarget(
  db: AppDatabase,
  tempGuid: string,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  return withDbTransaction(
    db,
    (context) => retireOutgoingWithinTransaction(context, tempGuid, ClientErrorCode.clientError),
    commitGuard,
  );
}

/**
 * Reconcile a send ack by tempGuid — the shared tail of every optimistic send
 * (text / attachment / reaction / queue retry). The ack carries the real GUID only on
 * the Private-API path; on the AppleScript fallback it is ABSENT — flip the optimistic
 * row to 'sent' and drop the queue row (no spurious retry), letting the live socket
 * `new-message` echo reconcile by content (Gator emits no tempGuid). Never call
 * reconcileOutgoingSuccess with an undefined guid. (An RCS ack echoes back our OWN
 * tempGuid as its correlation token — `reconcileOutgoingSuccess` itself backstops that
 * case, treating it exactly like the guid-absent fallback.)
 */
export async function reconcileSendOutcome(
  db: AppDatabase,
  tempGuid: string,
  ack: SendAck,
  now: number,
  commitGuard?: DbCommitGuard,
  options?: SendOutcomeOptions,
): Promise<void> {
  const ackGuid = ack.guid;
  const attemptOwnerToken = options?.attemptOwnerToken;
  const validAttemptGuid =
    typeof ack.attemptGuid === 'string' &&
    ack.attemptGuid.length >= 1 &&
    ack.attemptGuid.length <= 128;
  const validAttemptGeneration =
    Number.isInteger(ack.clientAttemptGeneration) &&
    ack.clientAttemptGeneration! >= 1 &&
    ack.clientAttemptGeneration! <= 2_147_483_647;
  const hasModernAttemptMetadata = ack.attemptGuid != null || ack.clientAttemptGeneration != null;
  if (hasModernAttemptMetadata && (!validAttemptGuid || !validAttemptGeneration)) {
    // Partial modern metadata is never legacy, even when the optimistic row was born before
    // attempt-aware mode was enabled. Falling back here would let an unverifiable ack consume it.
    throw new ApiError('parse_error', 'Server omitted RCS send attempt correlation');
  }
  let disposition: OutgoingAckDisposition;
  if (attemptOwnerToken) {
    if (!validAttemptGuid || !validAttemptGeneration) {
      // A capable server promised exact correlation. Treating a partial acknowledgement as legacy
      // would let an older delayed failure claim a newer retry under their shared temp GUID.
      throw new ApiError('parse_error', 'Server omitted RCS send attempt correlation');
    }
    disposition = await withDbTransaction(
      db,
      (context) =>
        reconcileOutgoingAttemptAckWithinTransaction(context, tempGuid, {
          guid: ackGuid,
          attemptGuid: ack.attemptGuid!,
          attemptOwnerToken,
          dateCreated: now,
          dateDelivered: null,
        }),
      commitGuard,
    );
  } else if (ackGuid && ackGuid !== tempGuid) {
    await withDbTransaction(
      db,
      (context) =>
        reconcileOutgoingSuccessWithinTransaction(context, tempGuid, {
          guid: ackGuid,
          dateCreated: now,
          dateDelivered: null,
        }),
      commitGuard,
    );
    disposition = 'sent';
  } else {
    disposition = await withDbTransaction(
      db,
      (context) => markOutgoingSentNoGuidWithinTransaction(context, tempGuid),
      commitGuard,
    );
  }
  if (
    (disposition === 'sent' || disposition === 'missing') &&
    options?.failureNoticeMode !== 'suppressed'
  ) {
    await clearFailedSendNotice(
      db,
      ackGuid && ackGuid !== tempGuid ? ackGuid : tempGuid,
      commitGuard,
    );
  }
}

/**
 * Flip a failed optimistic send to the error bubble. A development-only warning records the error
 * code/status/message for local diagnosis; release builds drop that free-form line before every
 * sink. `now` seeds the retry backoff (defaults to Date.now() before writer-queue admission).
 */
export async function handleSendFailure(
  db: AppDatabase,
  tempGuid: string,
  err: unknown,
  logTag: string,
  chatGuid: string,
  now?: number,
  commitGuard?: DbCommitGuard,
  options?: SendOutcomeOptions,
): Promise<void> {
  const status = err instanceof ApiError ? (err.status ?? null) : null;
  // Local-file, cancellation, and client-side timeout failures have no HTTP status, so
  // `sendErrorCode` would call all three a connection refusal. Name them for what they are instead.
  const kind = err instanceof ApiError ? err.kind : null;
  const code =
    kind === 'local_file'
      ? ClientErrorCode.attachmentUnreadable
      : kind === 'cancelled'
        ? ClientErrorCode.userCanceled
        : kind === 'timeout'
          ? ClientErrorCode.gatewayTimeout
          : kind === 'parse_error'
            ? ClientErrorCode.clientError
            : sendErrorCode(status);
  logger.warn(
    `[${logTag}] failed for chat ${chatGuid} (code ${code}${status != null ? `, HTTP ${status}` : ''}): ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
  const failedAt = now === undefined ? Date.now() : now;
  const serverDetail = err instanceof ApiError ? err.serverDetail : undefined;
  const reconciled = await withDbTransaction(
    db,
    (context) =>
      reconcileOutgoingErrorWithinTransaction(
        context,
        tempGuid,
        code,
        failedAt,
        serverDetail,
        options?.attemptOwnerToken,
      ),
    commitGuard,
  );
  if (reconciled && options?.failureNoticeMode !== 'suppressed') {
    await notifyFailedSend(db, chatGuid, tempGuid, commitGuard);
  }
}
