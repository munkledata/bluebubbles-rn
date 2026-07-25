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

/** Re-POST a single queued send (temp row + queue row already exist) and reconcile. */
async function resend(
  db: AppDatabase,
  http: HttpClient,
  io: OutgoingQueueIO,
  row: RetryableOutgoing,
  now: number,
): Promise<boolean> {
  try {
    // A retried row is 'error' from its last failure — flip it back to 'sending' FIRST, or the
    // guid-less ack paths (RCS tempGuid echo / AppleScript) hit markOutgoingSentNoGuid's
    // sticky-error guard and the retry's SUCCESS is swallowed: bubble stays errored, queue row
    // survives un-bumped, and the same message re-sends on every later drain (duplicates).
    await markOutgoingSending(db, row.tempGuid);
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
        return false;
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
      return false;
    }
    await reconcileSendOutcome(db, row.tempGuid, server, now);
    return true;
  } catch (e) {
    await handleSendFailure(db, row.tempGuid, e, 'queue', row.chatGuid, now);
    return false;
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
  let sent = 0;
  for (const row of rows) {
    if (!(await claimOutgoing(db, row.id, now))) continue; // another runner took it
    if (await resend(db, http, io, row, now)) sent += 1;
  }
  return { eligible: rows.length, sent };
}
