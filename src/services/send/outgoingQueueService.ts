import type { HttpClient } from '@core/api/http';
import { ApiError } from '@core/api/errors';
import { sendReaction, sendText } from '@core/api/endpoints/messages';
import { logger } from '@core/secure';
import {
  claimOutgoing,
  listRetryableOutgoing,
  markOutgoingSentNoGuid,
  reconcileOutgoingError,
  reconcileOutgoingSuccess,
  type RetryableOutgoing,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';

interface TextPayload {
  message: string;
  selectedMessageGuid?: string;
  effectId?: string;
}
interface ReactionPayload {
  selectedMessageGuid: string;
  reaction: string;
  selectedMessageText?: string;
}

/** Re-POST a single queued send (temp row + queue row already exist) and reconcile. */
async function resend(
  db: AppDatabase,
  http: HttpClient,
  row: RetryableOutgoing,
  now: number,
): Promise<boolean> {
  try {
    let server;
    if (row.kind === 'text') {
      const p = JSON.parse(row.payload) as TextPayload;
      server = await sendText(http, {
        chatGuid: row.chatGuid,
        tempGuid: row.tempGuid,
        message: p.message,
        selectedMessageGuid: p.selectedMessageGuid,
        effectId: p.effectId,
      });
    } else if (row.kind === 'reaction') {
      const p = JSON.parse(row.payload) as ReactionPayload;
      server = await sendReaction(http, {
        chatGuid: row.chatGuid,
        selectedMessageGuid: p.selectedMessageGuid,
        reaction: p.reaction,
        selectedMessageText: p.selectedMessageText,
      });
    } else {
      // Attachment re-upload from the queue isn't supported yet (needs the file at
      // localPath, which may be gone). The error bubble's manual retry still works.
      logger.debug(`[queue] skipping retry of unsupported kind: ${row.kind}`);
      return false;
    }
    // The Private-API path acks a real GUID → promote in place. The AppleScript fallback
    // returns no guid → mark sent + clear the queue, leaving the socket echo to reconcile
    // (never reconcile with an undefined guid).
    if (server.guid) {
      await reconcileOutgoingSuccess(db, row.tempGuid, {
        guid: server.guid,
        dateCreated: now,
        dateDelivered: null,
      });
    } else {
      await markOutgoingSentNoGuid(db, row.tempGuid);
    }
    return true;
  } catch (e) {
    const code = e instanceof ApiError && e.status ? e.status : -1;
    await reconcileOutgoingError(db, row.tempGuid, code, now);
    return false;
  }
}

/**
 * Process the outgoing queue: retry every eligible stranded/failed text + reaction send
 * with exponential backoff, retiring a row to the 'error' bubble after the attempt cap.
 * Each row is leased (claimOutgoing) so two concurrent runners never double-send. This is
 * the recovery missing from the original optimistic-send path — run it at boot and from
 * the background task (and the FCM wake, once provisioned). Pure orchestration (no RN
 * imports) → runs in Node tests against better-sqlite3.
 */
export async function runOutgoingQueue(
  db: AppDatabase,
  http: HttpClient,
  now: number = Date.now(),
): Promise<{ eligible: number; sent: number }> {
  const rows = await listRetryableOutgoing(db, now);
  let sent = 0;
  for (const row of rows) {
    if (!(await claimOutgoing(db, row.id, now))) continue; // another runner took it
    if (await resend(db, http, row, now)) sent += 1;
  }
  return { eligible: rows.length, sent };
}
