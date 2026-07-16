import * as scheduledApi from '@core/api/endpoints/scheduled';
import { getDatabase } from '@db/database';
import {
  cancelOutgoing as cancelOutgoingRepo,
  deleteMessageByGuid,
  deleteScheduled,
  getScheduledById,
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
import { expoAttachmentUploader } from './attachmentUpload';
import { runOutgoingQueue } from './outgoingQueueService';

export { runOutgoingQueue } from './outgoingQueueService';

export { generateTempGuid, sendTextMessage, type SendTextArgs } from './sendService';
export { sendImageMessage, type PickedImage } from './sendAttachmentService';
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
 */
export async function editScheduled(
  id: number,
  patch: { text: string; scheduledFor?: number },
): Promise<void> {
  const db = getDatabase();
  const row = await getScheduledById(db, id);
  if (row?.serverId != null) {
    // No PUT on Gator: delete the old server-side message, then create a replacement.
    await scheduledApi.deleteScheduled(http, row.serverId); // throws → local untouched, UI alerts
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

/** Pull the server's scheduled list into the local DB (keeps server-backed rows accurate). */
export async function syncScheduledFromServer(): Promise<void> {
  let items: Awaited<ReturnType<typeof scheduledApi.getScheduled>>;
  try {
    items = await scheduledApi.getScheduled(http);
  } catch {
    return; // older/offline server — keep local rows as-is
  }
  // EVERY id the server reported (even malformed items) — the prune set, so a row dropped by
  // the well-formed filter below is kept rather than pruned.
  const serverIds = items.map((it) => it.id);
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
 * Retry stranded/failed queued sends with backoff (the optimistic-send recovery).
 * Run at launch and from the background task — a crash mid-send no longer strands a
 * message; it retries automatically until it sends or retires to the error bubble.
 */
export function recoverOutgoing(now = Date.now()): Promise<{ eligible: number; sent: number }> {
  return runOutgoingQueue(getDatabase(), http, now);
}

/** Retry a failed send: drop the errored temp row, then re-send. */
export async function retry(
  oldTempGuid: string,
  args: SendTextArgs & { image?: PickedImage },
): Promise<{ tempGuid: string }> {
  // Drop the old errored row, then re-send. A failed ATTACHMENT must be re-uploaded as an
  // attachment (re-streaming its on-disk file) — the old code only re-sent text, so retrying a
  // failed picture just deleted it and sent nothing. When an image is supplied, re-send that.
  await deleteMessageByGuid(getDatabase(), oldTempGuid);
  if (args.image) {
    return sendImageMessage(
      getDatabase(),
      http,
      { chatGuid: args.chatGuid, image: args.image },
      expoAttachmentUploader,
    );
  }
  return sendTextMessage(getDatabase(), http, args);
}

/** Discard a failed/optimistic message (the "Delete" choice on a not-delivered message). */
export function discardMessage(guid: string): Promise<void> {
  return deleteMessageByGuid(getDatabase(), guid);
}

/**
 * Cancel a still-queued/sending (or errored) optimistic message: drop its queue
 * row + optimistic message. Guarded to a no-op once the send has reconciled to its
 * real guid (see cancelOutgoing repo helper). Returns whether anything was cancelled.
 */
export function cancelOutgoing(tempGuid: string): Promise<boolean> {
  return cancelOutgoingRepo(getDatabase(), tempGuid);
}
