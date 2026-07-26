import type { HttpClient } from '@core/api/http';
import {
  sendContact,
  sendReaction,
  sendText,
  type ContactEmail,
  type ContactPhone,
  type MessageMention,
} from '@core/api/endpoints/messages';
import { logger } from '@core/secure';
import {
  claimOutgoing,
  getAttachmentByGuid,
  listRetryableOutgoing,
  markOutgoingSending,
  retireOutgoing,
  type RetryableOutgoing,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { handleSendFailure, reconcileSendOutcome } from './sendOutcome';
import type { AttachmentUploader } from './sendAttachmentService';

interface TextPayload {
  message: string;
  selectedMessageGuid?: string;
  effectId?: string;
  subject?: string;
  mentions?: MessageMention[];
}
interface ReactionPayload {
  selectedMessageGuid: string;
  reaction: string;
  emoji?: string;
  selectedMessageText?: string;
}
interface AttachmentPayload {
  attachmentGuid: string;
  localPath?: string;
}
/**
 * A contact card's STRUCTURED fields (the server rebuilds the vCard). Queued under its own
 * kind so a retry re-sends the CARD — queuing contacts as 'text' made a failed send retry as
 * a plain message containing the contact's display name.
 */
interface ContactPayload {
  firstName?: string;
  lastName?: string;
  organization?: string;
  phones?: ContactPhone[];
  emails?: ContactEmail[];
  selectedMessageGuid?: string;
}

/**
 * The native I/O an attachment re-upload needs, INJECTED so this module stays free of RN
 * imports (it runs in Node tests against better-sqlite3). Production wires the expo
 * implementations (`expoAttachmentUploader` / `expoFileExists`); tests inject fakes.
 */
export interface OutgoingQueueIO {
  upload: AttachmentUploader;
  fileExists: (uri: string) => Promise<boolean>;
}

/** What one re-POST attempt did. 'unsendable' = retired for good (nothing can ever fix it). */
export type ResendOutcome = 'sent' | 'failed' | 'unsendable';

/**
 * Re-POST a single queued send (temp row + queue row already exist) and reconcile.
 *
 * Exported because the user's "Try Again" drives exactly one attempt through it: the manual retry
 * must re-POST the QUEUE PAYLOAD under the row's ORIGINAL temp guid, like the drain does, not
 * rebuild a send from the bubble under a fresh id. Rebuilding delivered a failed contact card as a
 * plain text message reading the contact's name; a fresh id defeats the server's temp-id-keyed
 * idempotency, so an ack-lost send goes out twice.
 *
 * `clock` is read at the OUTCOME, never at the top of the drain: a single attempt can run for
 * minutes (an attachment upload has no timeout), and stamping the backoff with a timestamp taken
 * before all the earlier rows in the batch schedules the next attempt too early — for a big upload,
 * into the past, which makes the row re-eligible on the very next 20 s tick with no backoff at all.
 */
export async function resendOutgoingRow(
  db: AppDatabase,
  http: HttpClient,
  io: OutgoingQueueIO,
  row: RetryableOutgoing,
  clock: () => number,
): Promise<ResendOutcome> {
  try {
    // The row is already flipped to 'sending' — that happens in the SAME transaction as the lease
    // (see runOutgoingQueue), never here, so there is no instant in which a leased row still reads
    // 'error' for the user's "Try Again" to claim out from under this attempt.
    let server;
    if (row.kind === 'text') {
      const p = JSON.parse(row.payload) as TextPayload;
      server = await sendText(http, {
        chatGuid: row.chatGuid,
        tempGuid: row.tempGuid,
        message: p.message,
        selectedMessageGuid: p.selectedMessageGuid,
        effectId: p.effectId,
        subject: p.subject,
        mentions: p.mentions,
      });
    } else if (row.kind === 'reaction') {
      const p = JSON.parse(row.payload) as ReactionPayload;
      server = await sendReaction(http, {
        chatGuid: row.chatGuid,
        selectedMessageGuid: p.selectedMessageGuid,
        reaction: p.reaction,
        emoji: p.emoji,
      });
    } else if (row.kind === 'contact') {
      const p = JSON.parse(row.payload) as ContactPayload;
      server = await sendContact(http, {
        chatGuid: row.chatGuid,
        tempGuid: row.tempGuid,
        firstName: p.firstName,
        lastName: p.lastName,
        organization: p.organization,
        phones: p.phones,
        emails: p.emails,
        selectedMessageGuid: p.selectedMessageGuid,
      });
    } else if (row.kind === 'attachment') {
      const p = JSON.parse(row.payload) as AttachmentPayload;
      // name/mimeType live on the attachments row (the payload only pins guid + path); the
      // row also holds the freshest localPath should anything have rewritten it.
      const att = await getAttachmentByGuid(db, p.attachmentGuid);
      const uri = att?.localPath ?? p.localPath;
      if (!att || !uri || !(await io.fileExists(uri))) {
        // The on-disk file is gone (OS cache eviction / rows deleted) — no retry can ever
        // succeed. Retire now instead of burning attempts; the bubble keeps its error badge
        // and the sheet's Delete still works.
        logger.warn(`[queue] attachment retry has no local file — retiring`);
        await retireOutgoing(db, row.tempGuid);
        return 'unsendable';
      }
      server = await io.upload({
        http,
        chatGuid: row.chatGuid,
        tempGuid: row.tempGuid,
        name: att.transferName ?? 'attachment',
        uri,
        mimeType: att.mimeType ?? 'application/octet-stream',
      });
    } else {
      // Unknown kind: retire rather than skip, or the row is claimed-and-skipped on every
      // drain forever (the old zombie behavior attachments used to have).
      logger.warn(`[queue] unknown outgoing kind '${row.kind}' — retiring`);
      await retireOutgoing(db, row.tempGuid);
      return 'unsendable';
    }
    await reconcileSendOutcome(db, row.tempGuid, server, clock());
    return 'sent';
  } catch (e) {
    await handleSendFailure(db, row.tempGuid, e, 'queue', row.chatGuid, clock());
    return 'failed';
  }
}

/**
 * Process the outgoing queue: retry every eligible stranded/failed text, reaction, and
 * attachment send with exponential backoff, retiring a row to the 'error' bubble after the
 * attempt cap (or immediately when its local file is gone). Each row is leased
 * (claimOutgoing) so two concurrent runners never double-send; retries reuse the original
 * tempGuid so the server's idempotency cache can absorb an ack-lost duplicate. This is the
 * recovery missing from the original optimistic-send path — run it at boot, from the
 * background task, and from the in-session drains (chat ticker / AppState active). Pure
 * orchestration (no RN imports — attachment I/O is injected) → runs in Node tests.
 */
export async function runOutgoingQueue(
  db: AppDatabase,
  http: HttpClient,
  io: OutgoingQueueIO,
  now: number = Date.now(),
): Promise<{ eligible: number; sent: number }> {
  const rows = await listRetryableOutgoing(db, now);
  // `now` anchors the drain (and is injectable, so tests keep a deterministic clock), but every
  // claim and every outcome reads the time AGAIN through here. A single loop-start value both
  // under-schedules the backoff of every row after the first and hands each row a lease measured
  // from before the batch started — so a long upload can outlive its own 120 s lease and a second
  // drain re-claims the row and uploads the same file again alongside it.
  const startedAt = Date.now();
  const clock = (): number => now + (Date.now() - startedAt);
  let sent = 0;
  for (const row of rows) {
    // THE LEASE AND THE VISIBLE STATE FLIP ARE ONE STEP. The lease (`claimOutgoing`) lives in
    // outgoing_queue.next_retry_at; 'sending' on the message row is what every OTHER actor reads
    // — the "Try Again" button's claim is a compare-and-set on `send_state = 'error'`. Done as two
    // separate writes, a row that had just been leased still read 'error', so a tap landing between
    // them deleted the bubble + queue row and re-sent under a NEW temp guid while this attempt
    // POSTed under the old one: two idempotency keys, one message delivered twice.
    //
    // The flip is also what keeps a retry's SUCCESS from being swallowed: a row retried from
    // 'error' that acks without a guid (RCS tempGuid echo / AppleScript) hits
    // markOutgoingSentNoGuid's sticky-error guard, and the bubble stays errored with its queue row
    // un-bumped — so the same message re-sends on every later drain (duplicates).
    const claimed = await withDbTransaction(db, async () => {
      if (!(await claimOutgoing(db, row.id, clock()))) return false; // another runner took it
      await markOutgoingSending(db, row.tempGuid);
      return true;
    });
    if (!claimed) continue;
    if ((await resendOutgoingRow(db, http, io, row, clock)) === 'sent') sent += 1;
  }
  return { eligible: rows.length, sent };
}
