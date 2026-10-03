import type { SendAck } from '@core/api/endpoints/messages';
import { ApiError } from '@core/api/errors';
import { logger } from '@core/secure';
import {
  ClientErrorCode,
  IMESSAGE_PLAIN_TEXT_DELIVERY_UNCONFIRMED_COPY,
  LOCATION_DELIVERY_UNCONFIRMED_COPY,
  sendErrorCode,
} from '@utils';
import {
  markOutgoingSentNoGuidWithinTransaction,
  reconcileOutgoingAttemptAckWithinTransaction,
  reconcileOutgoingErrorWithinTransaction,
  reconcileOutgoingSuccessWithinTransaction,
  retireOutgoingWithinTransaction,
  retireUncertainOutgoingWithinTransaction,
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
  /** One-shot helper mutation: a failed HTTP/parse outcome may still have delivered. */
  readonly terminalUncertain?: boolean;
  /** Identifies the one-shot surface so its terminal status and recovery copy stay truthful. */
  readonly terminalUncertainKind?:
    'attachment' | 'reply' | 'location' | 'effect' | 'mention' | 'formatted' | 'plain';
  /** Exact helper refusal proved that no dispatch began, authorizing one future narrow retry. */
  readonly imessagePlainTextRetrySafe?: boolean;
  /** Exact locally selected conversation; survives temp-row/queue cleanup during a late ack. */
  readonly expectedChatGuid?: string;
}

export const UNCERTAIN_IMESSAGE_ATTACHMENT_COPY =
  'Delivery may have occurred. Check Messages before sending a new copy.';
export const UNCERTAIN_IMESSAGE_REPLY_COPY =
  'This reply may have been delivered. Check Messages before sending a new copy.';
export const UNCERTAIN_IMESSAGE_LOCATION_COPY = LOCATION_DELIVERY_UNCONFIRMED_COPY;
export const UNCERTAIN_IMESSAGE_EFFECT_COPY =
  'This effect message may have been delivered. Check Messages before sending a new copy.';
export const UNCERTAIN_IMESSAGE_MENTION_COPY =
  'This mention message may have been delivered. Check Messages before sending a new copy.';
export const UNCERTAIN_IMESSAGE_FORMATTED_COPY =
  'This formatted message may have been delivered. Check Messages before sending a new copy.';
export const UNCERTAIN_IMESSAGE_PLAIN_TEXT_COPY = IMESSAGE_PLAIN_TEXT_DELIVERY_UNCONFIRMED_COPY;

/** Fixed server outcomes that make another location attempt unsafe or invalid. */
export function isTerminalLocationSendError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return (
    error.serverErrorType === 'idempotency_outcome_unknown' ||
    error.serverErrorType === 'imessage_location_outcome_unknown' ||
    error.serverErrorType === 'idempotency_key_reused' ||
    error.serverErrorType === 'imessage_location_invalid_target'
  );
}

const REJECTED_IMESSAGE_ATTACHMENT_COPY =
  'The server rejected this upload before dispatch. This attempt was not sent.';
const REJECTED_IMESSAGE_REPLY_COPY =
  'The server rejected this reply before dispatch. This attempt was not sent.';
const REJECTED_IMESSAGE_LOCATION_COPY =
  'The server rejected this location before dispatch. This attempt was not sent.';
const REJECTED_IMESSAGE_PLAIN_TEXT_COPY =
  'The server rejected this message before dispatch. This attempt was not sent.';

const PRE_DISPATCH_ATTACHMENT_ERROR_TYPES: Readonly<Record<number, ReadonlySet<string>>> = {
  400: new Set([
    'attachment_text_too_large',
    'chat_guid_required_before_file',
    'duplicate_chat_guid',
    'duplicate_attachment_field',
    'idempotency_key_invalid',
    'imessage_attachment_caption_unavailable',
    'imessage_attachment_fields_unsupported',
    'imessage_attachment_type_unsupported',
    'imessage_retry_key_required',
    'imessage_reply_invalid_target',
    'imessage_voice_mode_invalid',
    'imessage_voice_type_unsupported',
    'invalid_attachment_text',
    'invalid_filename',
    'invalid_imessage_chat_guid',
    'imessage_contact_invalid_target',
    'imessage_location_invalid_target',
    'imessage_plain_text_invalid_target',
    'malformed_multipart',
    'multipart_field_too_large',
  ]),
  404: new Set(['imessage_chat_not_found']),
  409: new Set(['idempotency_key_reused', 'imessage_plain_text_rejected']),
  413: new Set([
    'imessage_attachment_too_large',
    'imessage_contact_too_large',
    'multipart_limit',
    'staging_request_too_large',
  ]),
  503: new Set([
    'idempotency_persistence_unavailable',
    'imessage_contact_unavailable',
    'imessage_reply_unavailable',
    'staging_check_failed',
    'staging_object_limit',
    'staging_quota_exceeded',
    'staging_space_low',
  ]),
};

/** Only reviewed machine types prove that a response predates a one-shot helper dispatch. */
function isPreDispatchOneShotRejection(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status !== undefined &&
    err.serverErrorType !== undefined &&
    PRE_DISPATCH_ATTACHMENT_ERROR_TYPES[err.status]?.has(err.serverErrorType) === true
  );
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
          expectedChatGuid: options?.expectedChatGuid,
          dateCreated: now,
          dateDelivered: null,
        }),
      commitGuard,
    );
  } else if (ackGuid && ackGuid !== tempGuid) {
    await withDbTransaction(
      db,
      (context) =>
        reconcileOutgoingSuccessWithinTransaction(
          context,
          tempGuid,
          {
            guid: ackGuid,
            dateCreated: now,
            dateDelivered: null,
          },
          options?.expectedChatGuid,
        ),
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
    // Failure notices are born under the optimistic temp row. Successful promotion leaves an
    // alias back to that row; a cross-chat collision deliberately does not. Always following the
    // temp identity therefore clears the source notice without ever touching a foreign canonical.
    await clearFailedSendNotice(db, tempGuid, commitGuard);
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
  const terminalKind =
    options?.terminalUncertainKind ?? (options?.terminalUncertain === true ? 'attachment' : null);
  const preDispatchRejection = terminalKind != null && isPreDispatchOneShotRejection(err);
  if (terminalKind) {
    logger.warn(
      `[${logTag}] one-shot ${terminalKind} ${preDispatchRejection ? 'rejected before dispatch' : 'outcome unconfirmed'} (code ${code}${status != null ? `, HTTP ${status}` : ''})`,
    );
  } else {
    logger.warn(
      `[${logTag}] failed for chat ${chatGuid} (code ${code}${status != null ? `, HTTP ${status}` : ''}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const failedAt = now === undefined ? Date.now() : now;
  const serverDetail = err instanceof ApiError ? err.serverDetail : undefined;
  const reconciled = await withDbTransaction(
    db,
    (context) =>
      terminalKind
        ? retireUncertainOutgoingWithinTransaction(
            context,
            tempGuid,
            preDispatchRejection
              ? terminalKind === 'location'
                ? ClientErrorCode.locationRejected
                : code
              : terminalKind === 'reply'
                ? ClientErrorCode.replyDeliveryUnconfirmed
                : terminalKind === 'location'
                  ? ClientErrorCode.locationDeliveryUnconfirmed
                  : terminalKind === 'effect'
                    ? ClientErrorCode.effectDeliveryUnconfirmed
                    : terminalKind === 'mention'
                      ? ClientErrorCode.mentionDeliveryUnconfirmed
                      : terminalKind === 'formatted'
                        ? ClientErrorCode.formattedDeliveryUnconfirmed
                        : ClientErrorCode.attachmentDeliveryUnconfirmed,
            preDispatchRejection
              ? terminalKind === 'reply'
                ? REJECTED_IMESSAGE_REPLY_COPY
                : terminalKind === 'location'
                  ? REJECTED_IMESSAGE_LOCATION_COPY
                  : terminalKind === 'plain'
                    ? REJECTED_IMESSAGE_PLAIN_TEXT_COPY
                    : REJECTED_IMESSAGE_ATTACHMENT_COPY
              : terminalKind === 'reply'
                ? UNCERTAIN_IMESSAGE_REPLY_COPY
                : terminalKind === 'location'
                  ? UNCERTAIN_IMESSAGE_LOCATION_COPY
                  : terminalKind === 'effect'
                    ? UNCERTAIN_IMESSAGE_EFFECT_COPY
                    : terminalKind === 'mention'
                      ? UNCERTAIN_IMESSAGE_MENTION_COPY
                      : terminalKind === 'formatted'
                        ? UNCERTAIN_IMESSAGE_FORMATTED_COPY
                        : terminalKind === 'plain'
                          ? UNCERTAIN_IMESSAGE_PLAIN_TEXT_COPY
                          : UNCERTAIN_IMESSAGE_ATTACHMENT_COPY,
            terminalKind === 'location',
          )
        : reconcileOutgoingErrorWithinTransaction(
            context,
            tempGuid,
            code,
            failedAt,
            serverDetail,
            options?.attemptOwnerToken,
            options?.imessagePlainTextRetrySafe === true,
          ),
    commitGuard,
  );
  if (reconciled && options?.failureNoticeMode !== 'suppressed') {
    await notifyFailedSend(db, chatGuid, tempGuid, commitGuard);
  }
}
