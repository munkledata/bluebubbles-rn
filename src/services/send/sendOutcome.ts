import type { SendAck } from '@core/api/endpoints/messages';
import { ApiError } from '@core/api/errors';
import { logger } from '@core/secure';
import { ClientErrorCode, sendErrorCode } from '@utils';
import {
  markOutgoingSentNoGuid,
  reconcileOutgoingError,
  reconcileOutgoingSuccess,
} from '@db/repositories';
import type { DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { clearFailedSendNotice, notifyFailedSend } from './sendFailureNotice';

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
): Promise<void> {
  if (ack.guid) {
    await reconcileOutgoingSuccess(
      db,
      tempGuid,
      {
        guid: ack.guid,
        dateCreated: now,
        dateDelivered: null,
      },
      commitGuard,
    );
  } else {
    await markOutgoingSentNoGuid(db, tempGuid, commitGuard);
  }
  await clearFailedSendNotice(
    db,
    ack.guid && ack.guid !== tempGuid ? ack.guid : tempGuid,
    commitGuard,
  );
}

/**
 * Flip a failed optimistic send to the error bubble. A development-only warning records the error
 * code/status/message for local diagnosis; release builds drop that free-form line before every
 * sink. `now` seeds the retry backoff (defaults to Date.now() in the repo).
 */
export async function handleSendFailure(
  db: AppDatabase,
  tempGuid: string,
  err: unknown,
  logTag: string,
  chatGuid: string,
  now?: number,
  commitGuard?: DbCommitGuard,
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
          : sendErrorCode(status);
  logger.warn(
    `[${logTag}] failed for chat ${chatGuid} (code ${code}${status != null ? `, HTTP ${status}` : ''}): ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
  const reconciled = await reconcileOutgoingError(
    db,
    tempGuid,
    code,
    now,
    commitGuard,
    err instanceof ApiError ? err.serverDetail : undefined,
  );
  if (reconciled) await notifyFailedSend(db, chatGuid, tempGuid, commitGuard);
}
