import type { SendAck } from '@core/api/endpoints/messages';
import { ApiError } from '@core/api/errors';
import { logger } from '@core/secure';
import { sendErrorCode } from '@utils';
import {
  markOutgoingSentNoGuid,
  reconcileOutgoingError,
  reconcileOutgoingSuccess,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';

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
): Promise<void> {
  if (ack.guid) {
    await reconcileOutgoingSuccess(db, tempGuid, {
      guid: ack.guid,
      dateCreated: now,
      dateDelivered: null,
    });
  } else {
    await markOutgoingSentNoGuid(db, tempGuid);
  }
}

/**
 * Flip a failed optimistic send to the error bubble, logging WHY it failed (error code +
 * HTTP status + server message) so a failed bubble is diagnosable from the device log —
 * e.g. an RCS auth-expiry reads "...Google login expired... refresh cookies on the
 * dashboard" instead of a silent errored bubble. The redacting logger scrubs any secret
 * before sinks. `now` seeds the retry backoff (defaults to Date.now() in the repo).
 */
export async function handleSendFailure(
  db: AppDatabase,
  tempGuid: string,
  err: unknown,
  logTag: string,
  chatGuid: string,
  now?: number,
): Promise<void> {
  const status = err instanceof ApiError ? (err.status ?? null) : null;
  const code = sendErrorCode(status);
  logger.warn(
    `[${logTag}] failed for chat ${chatGuid} (code ${code}${status != null ? `, HTTP ${status}` : ''}): ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
  await reconcileOutgoingError(db, tempGuid, code, now);
}
