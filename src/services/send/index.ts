import * as scheduledApi from '@core/api/endpoints/scheduled';
import { logger } from '@core/secure';
import { getDatabase } from '@db/database';
import {
  claimFailedOutgoingForRetry,
  countOutgoingQueueHealth,
  deleteMessageLocal,
  deleteScheduled,
  discardOutgoingMessage,
  getScheduledById,
  listAllScheduled,
  reconcileServerScheduled,
  resetStuckScheduled,
  updateScheduled,
} from '@db/repositories';
import { http } from '../clients';
import { sendTextMessage, type SendTextArgs } from './sendService';
import { sendReactionMessage, type SendReactionArgs } from './sendReactionService';
import { sendEdit, sendUnsend } from './sendEditService';
import { runDueScheduled, scheduleTextMessage, type ScheduleArgs } from './scheduleService';
import { sendImageMessage, type PickedImage } from './sendAttachmentService';
import { sendContactMessage, hasContactContent, type ContactCard } from './sendContactService';
import { pickContact } from '../contacts/contactsService';
import { expoAttachmentUploader, expoFileExists } from './attachmentUpload';
import { uploadRegistry } from './uploadControl';
import { resendOutgoingRow, runOutgoingQueue, type OutgoingQueueIO } from './outgoingQueueService';
import { showToast } from '@ui/toast/toastStore';

export { runOutgoingQueue, type OutgoingQueueIO } from './outgoingQueueService';

/** The production attachment I/O for the outgoing queue (expo uploader + on-disk check). */
export const outgoingQueueIO: OutgoingQueueIO = {
  upload: expoAttachmentUploader,
  fileExists: expoFileExists,
};

export { generateTempGuid, sendTextMessage, type SendTextArgs } from './sendService';
export { sendImageMessage, type PickedImage } from './sendAttachmentService';
export {
  sendContactMessage,
  contactDisplayName,
  hasContactContent,
  type ContactCard,
} from './sendContactService';
export { sendReactionMessage, type SendReactionArgs } from './sendReactionService';
export { sendEdit, sendUnsend, type SendEditArgs } from './sendEditService';
export { runDueScheduled, scheduleTextMessage, type ScheduleArgs } from './scheduleService';

/** UI-facing image send: bound to the composition-root DB + HttpClient. */
export function sendImage(args: {
  chatGuid: string;
  image: PickedImage;
}): Promise<{ tempGuid: string }> {
  return sendImageMessage(getDatabase(), http, args, expoAttachmentUploader);
}

/** UI-facing multi-image send: one optimistic message + attachment per picked asset. */
export function sendImages(args: {
  chatGuid: string;
  images: PickedImage[];
}): Promise<{ tempGuid: string }[]> {
  return Promise.all(
    args.images.map((image) =>
      sendImageMessage(
        getDatabase(),
        http,
        { chatGuid: args.chatGuid, image },
        expoAttachmentUploader,
      ),
    ),
  );
}

/** UI-facing send: bound to the composition-root DB + HttpClient. */
export function send(args: SendTextArgs): Promise<{ tempGuid: string }> {
  return sendTextMessage(getDatabase(), http, args);
}

/** UI-facing contact-card send: bound to the composition-root DB + HttpClient. */
export function sendContactCard(args: {
  chatGuid: string;
  contact: ContactCard;
  replyToGuid?: string;
}): Promise<{ tempGuid: string }> {
  return sendContactMessage(getDatabase(), http, {
    chatGuid: args.chatGuid,
    contact: args.contact,
    selectedMessageGuid: args.replyToGuid,
  });
}

/**
 * UI-facing "share a contact" flow: open the native picker, then send the chosen contact as a
 * card. Returns null when the user cancels/denies the picker or the contact has no usable field.
 * Kept here (not in the chat screen) so the screen depends only on the send barrel — and so the
 * expo-contacts native import stays out of the screen's module graph.
 */
export async function pickAndSendContact(chatGuid: string): Promise<{ tempGuid: string } | null> {
  const contact = await pickContact();
  if (!contact || !hasContactContent(contact)) return null;
  return sendContactCard({ chatGuid, contact });
}

/** UI-facing tapback send (toggle: pass '-love' to remove). */
export function react(args: SendReactionArgs): Promise<{ tempGuid: string }> {
  return sendReactionMessage(getDatabase(), http, args);
}

/** UI-facing threaded reply: a text send whose reply target is `replyToGuid`. */
export function reply(args: {
  chatGuid: string;
  text: string;
  replyToGuid: string;
  effectId?: string;
}): Promise<{ tempGuid: string }> {
  return sendTextMessage(getDatabase(), http, {
    chatGuid: args.chatGuid,
    text: args.text,
    selectedMessageGuid: args.replyToGuid,
    effectId: args.effectId,
  });
}

/** UI-facing edit of a sent message's text (optimistic + revert on failure). */
export function editText(args: {
  messageGuid: string;
  newText: string;
  chatGuid?: string;
}): Promise<{ ok: boolean }> {
  return sendEdit(getDatabase(), http, args);
}

/** UI-facing unsend/retract of a sent message. */
export function unsend(args: { messageGuid: string; chatGuid?: string }): Promise<{ ok: boolean }> {
  return sendUnsend(getDatabase(), http, args);
}

/** UI-facing: store a message to send later (server-side when possible). */
export function schedule(args: ScheduleArgs): Promise<{ id: number; serverId: string | null }> {
  return scheduleTextMessage(getDatabase(), http, args);
}

/**
 * Cancel a scheduled message. For a server-backed row the SERVER delete must succeed FIRST —
 * if it fails we keep the local row and rethrow (the message is still scheduled server-side,
 * so the user must be able to retry the cancel rather than lose the only handle to it).
 */
export async function cancelScheduled(row: { id: number; serverId: string | null }): Promise<void> {
  if (row.serverId != null) {
    await scheduledApi.deleteScheduled(http, row.serverId); // throws → local kept, UI alerts
  }
  await deleteScheduled(getDatabase(), row.id);
}

/**
 * Edit a scheduled message's text/time. Gator has NO update endpoint, so for a server-backed
 * row we re-create it: DELETE the old scheduled message, POST a fresh one, then point the local
 * row at the new uuid. The server call goes FIRST — any failure rethrows so the edit screen can
 * surface it instead of silently diverging from the server. Local-only rows just update locally.
 * Adding a RECURRENCE to a server-backed row converts it to LOCAL-ONLY (delete server-side, no
 * re-create) — the server can't repeat, so the on-device ticker must own the row to re-arm it.
 */
export async function editScheduled(
  id: number,
  patch: { text: string; scheduledFor?: number; recurrence?: string | null },
): Promise<void> {
  const db = getDatabase();
  const row = await getScheduledById(db, id);
  if (row?.serverId != null) {
    // No PUT on Gator: delete the old server-side message, then create a replacement.
    await scheduledApi.deleteScheduled(http, row.serverId); // throws → local untouched, UI alerts
    if (patch.recurrence) {
      // Now recurring → keep it local-only so the ticker (which skips server-backed rows)
      // fires and re-arms it. The server row is already gone; just drop the serverId.
      await updateScheduled(db, id, { ...patch, serverId: null });
      return;
    }
    let newServerId: string | null;
    try {
      const created = await scheduledApi.createScheduled(http, {
        chatGuid: row.chatGuid,
        message: patch.text,
        scheduledFor: patch.scheduledFor ?? row.scheduledFor,
      });
      newServerId = created?.id ?? null;
    } catch (e) {
      // DELETE succeeded but the re-create failed: the old server message is gone. DROP the
      // serverId so the on-device worker fires the edited message as a fallback (rather than
      // orphaning it — a non-null serverId would make the local worker skip it forever), apply
      // the edit locally, then surface the failure.
      await updateScheduled(db, id, { ...patch, serverId: null });
      throw e;
    }
    // Repoint the local row at the fresh uuid alongside the text/time change.
    await updateScheduled(db, id, { ...patch, serverId: newServerId });
    return;
  }
  await updateScheduled(db, id, patch);
}

/** Gator scheduled status (pending|sent|failed) → local {pending,sent,error} so pending rows stay visible. */
function normalizeSchedStatus(s: string | null | undefined): string {
  const v = (s ?? '').toLowerCase();
  if (v === 'complete' || v === 'completed' || v === 'sent') return 'sent';
  if (v === 'error' || v === 'failed') return 'error';
  return 'pending'; // pending / scheduled → keep visible + cancellable
}

/** Server ids of the local server-backed rows still pending — the prune-exposure snapshot. */
async function pendingServerIds(): Promise<Set<string>> {
  const rows = await listAllScheduled(getDatabase());
  return new Set(rows.map((r) => r.serverId).filter((id): id is string => id != null));
}

/** Pull the server's scheduled list into the local DB (keeps server-backed rows accurate). */
export async function syncScheduledFromServer(): Promise<void> {
  // Snapshot which rows this reconcile is ALLOWED to prune BEFORE the round trip. The server's
  // answer describes the instant it was built, and the Scheduled screen's Edit re-creates a
  // server-side message (delete + POST) — a row created while the GET was in flight is missing
  // from that answer through no fault of its own, and pruning it deletes the local handle to a
  // message the server will still fire.
  const before = await pendingServerIds();
  let items: Awaited<ReturnType<typeof scheduledApi.getScheduled>>;
  try {
    items = await scheduledApi.getScheduled(http);
  } catch {
    return; // older/offline server — keep local rows as-is
  }
  // EVERY id the server reported (even malformed items) — the prune set, so a row dropped by
  // the well-formed filter below is kept rather than pruned.
  const serverIds = items.map((it) => it.id);
  // Rows that appeared locally during the round trip are added to the keep set. Only when the
  // server actually reported something: an empty answer must still skip pruning entirely
  // (reconcileServerScheduled's own guard against a transient empty view wiping live rows), so
  // never let these turn an empty set into a non-empty one.
  if (serverIds.length > 0) {
    for (const id of await pendingServerIds()) {
      if (!before.has(id)) serverIds.push(id);
    }
  }
  const mapped = items
    .map((it) => {
      if (!Number.isFinite(it.scheduledFor)) return null;
      return {
        serverId: it.id,
        chatGuid: it.chatGuid,
        text: it.text,
        scheduledFor: it.scheduledFor,
        status: normalizeSchedStatus(it.status),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);
  await reconcileServerScheduled(getDatabase(), mapped, serverIds);
}

/** Fire any scheduled messages now due (real send path). */
export function fireDueScheduled(now = Date.now()): Promise<number> {
  return runDueScheduled(getDatabase(), http, now);
}

/** Recover rows interrupted mid-send (left 'sending'). Run once at app launch. */
export function recoverStuckScheduled(): Promise<number> {
  return resetStuckScheduled(getDatabase());
}

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
  // Before the drain, so the counts describe what the last session left behind rather than what
  // this one just repaired. Gated to the first call, which is the boot drain.
  await reportQueueHealthOnce();
  return runOutgoingQueue(getDatabase(), http, outgoingQueueIO, now);
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
 * seconds (an attachment upload has no timeout at all), while the sheet the user is tapping opened
 * before any of that. Only an 'error' row with a live ladder is ours; anything else says so and
 * re-sends nothing.
 */
export async function retry(tempGuid: string): Promise<void> {
  // NEVER rejects. The only call site is a `void retry(...)` in a press handler, so a rejection
  // here is an unhandled promise: no toast, no log, a tap that visibly did nothing. The bubble and
  // its ladder survive any failure now, so there is nothing to repair — only something to report.
  try {
    const db = getDatabase();
    const { claim, row } = await claimFailedOutgoingForRetry(db, tempGuid);
    if (claim !== 'claimed' || !row) {
      showToast(
        claim === 'sending'
          ? 'Already trying to send this message'
          : claim === 'settled'
            ? 'Message was already sent'
            : 'This message can’t be sent again',
      );
      return;
    }
    // The same attempt the drain would make — same payload, same temp guid, same reconcile.
    const outcome = await resendOutgoingRow(db, http, outgoingQueueIO, row, () => Date.now());
    // Retired for good: the attachment's on-disk file is gone, so no re-send can ever work. The
    // bubble keeps its error badge (Delete on the sheet still works) — say why rather than leave
    // the tap looking like it did nothing.
    if (outcome === 'unsendable') showToast('Original file is no longer available');
  } catch (e) {
    // A DB/driver failure in the claim itself. The automatic ladder still owns the row.
    logger.warn('[send] manual retry failed', e);
    showToast('Couldn’t retry — try again in a moment');
  }
}

/**
 * Discard a message from the user's "Delete" (single or bulk), whatever state it is in.
 *
 * TWO STEPS, and each one puts its condition in its own write, so between them every state is
 * covered exactly once:
 *  1. `discardOutgoingMessage` claims ONLY an unconfirmed optimistic row (a `temp-` guid still
 *     'sending' or 'error'): it tombstones the bubble and takes its queue row with it, so the
 *     retry ladder can't re-POST what the user just removed.
 *  2. Everything else — a real server guid, and a `temp-` row already flipped to 'sent' by a
 *     guid-less ack (RCS / AppleScript) — falls through to `deleteMessageLocal`.
 * BOTH steps tombstone; the difference is only which one owns the queue row and the ownership
 * answer the caller gets. Every state here is a message the server may still have, and a hard
 * delete of any of them is undone the next time the thread syncs (`ensureChatSynced` re-pages 500
 * messages on EVERY chat open) — `date_deleted` is the only thing that survives that.
 * The step-1 helper returning "I cleaned something up" instead of "I own this message" is what
 * made a Delete silently do nothing, so it now reports ownership only.
 */
export async function discardMessage(guid: string, now: number = Date.now()): Promise<void> {
  // STOP THE BYTES FIRST, before either tombstone. "Cancel Sending" used to be a pure DB write:
  // the bubble vanished while the phone carried on streaming the entire file to the server — on a
  // large video, for minutes, over the user's data. The upload simply had no cancel handle to
  // reach for. Cancelling is safe for every other message kind too: nothing is registered under a
  // text/reaction/contact temp guid, so this is a no-op for them.
  uploadRegistry.cancel(guid);
  const db = getDatabase();
  if (await discardOutgoingMessage(db, guid, now)) return;
  await deleteMessageLocal(db, guid, now);
}

/*
 * There is deliberately NO `cancelOutgoing` wrapper here any more. "Cancel Sending" and "Remove"
 * are worded differently but ask for the same thing, and routing them at only
 * `discardOutgoingMessage` made the tap a SILENT NO-OP whenever the send completed while the
 * confirmation dialog was on screen (seconds — the guard then matches nothing and the boolean is
 * discarded). Every user-facing removal goes through {@link discardMessage}, whose second step
 * removes what the first does not own.
 */
