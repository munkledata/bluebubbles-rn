import * as scheduledApi from '@core/api/endpoints/scheduled';
import { getDatabase } from '@db/database';
import {
  deleteMessageByGuid,
  deleteScheduled,
  getScheduledById,
  reconcileServerScheduled,
  resetStuckScheduled,
  updateScheduled,
} from '@db/repositories';
import { http } from '@/services';
import { sendTextMessage, type SendTextArgs } from './sendService';
import { sendReactionMessage, type SendReactionArgs } from './sendReactionService';
import { sendEdit, sendUnsend } from './sendEditService';
import { runDueScheduled, scheduleTextMessage, type ScheduleArgs } from './scheduleService';
import { sendImageMessage, type PickedImage } from './sendAttachmentService';
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
  return sendImageMessage(getDatabase(), http, args);
}

/** UI-facing multi-image send: one optimistic message + attachment per picked asset. */
export function sendImages(args: {
  chatGuid: string;
  images: PickedImage[];
}): Promise<{ tempGuid: string }[]> {
  return Promise.all(
    args.images.map((image) =>
      sendImageMessage(getDatabase(), http, { chatGuid: args.chatGuid, image }),
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
export function editText(args: { messageGuid: string; newText: string }): Promise<{ ok: boolean }> {
  return sendEdit(getDatabase(), http, args);
}

/** UI-facing unsend/retract of a sent message. */
export function unsend(args: { messageGuid: string }): Promise<{ ok: boolean }> {
  return sendUnsend(getDatabase(), http, args);
}

/** UI-facing: store a message to send later (server-side when possible). */
export function schedule(args: ScheduleArgs): Promise<{ id: number; serverId: number | null }> {
  return scheduleTextMessage(getDatabase(), http, args);
}

/**
 * Cancel a scheduled message. For a server-backed row the SERVER delete must succeed FIRST —
 * if it fails we keep the local row and rethrow (the message is still scheduled server-side,
 * so the user must be able to retry the cancel rather than lose the only handle to it).
 */
export async function cancelScheduled(row: { id: number; serverId: number | null }): Promise<void> {
  if (row.serverId != null) {
    await scheduledApi.deleteScheduled(http, row.serverId); // throws → local kept, UI alerts
  }
  await deleteScheduled(getDatabase(), row.id);
}

/**
 * Edit a scheduled message's text/time. For a server-backed row the SERVER update goes FIRST
 * (preserving its recurrence schedule); only on success is the local row updated. A failed PUT
 * rethrows so the edit screen can surface it instead of silently diverging from the server.
 */
export async function editScheduled(
  id: number,
  patch: { text: string; scheduledFor?: number },
): Promise<void> {
  const db = getDatabase();
  const row = await getScheduledById(db, id);
  if (row?.serverId != null) {
    let schedule: scheduledApi.ScheduleSpec | undefined;
    try {
      // Preserve the server's recurrence — read its current schedule and forward it, so an
      // edit doesn't silently downgrade a recurring message to one-time.
      const cur = (await scheduledApi.getScheduled(http)).find((it) => it.id === row.serverId);
      if (cur?.schedule?.type) {
        schedule = {
          type: cur.schedule.type === 'recurring' ? 'recurring' : 'once',
          interval: cur.schedule.interval ?? undefined,
          intervalType: cur.schedule.intervalType as scheduledApi.ScheduleSpec['intervalType'],
        };
      }
    } catch {
      /* couldn't read the schedule — the PUT below still preserves text/time */
    }
    await scheduledApi.updateScheduled(http, row.serverId, {
      chatGuid: row.chatGuid,
      message: patch.text,
      scheduledFor: patch.scheduledFor ?? row.scheduledFor,
      schedule,
    });
  }
  await updateScheduled(db, id, patch);
}

/** Server scheduled status → local {pending,sent,error} so active/recurring rows stay visible. */
function normalizeSchedStatus(s: string | null | undefined): string {
  const v = (s ?? '').toLowerCase();
  if (v === 'complete' || v === 'completed' || v === 'sent') return 'sent';
  if (v === 'error' || v === 'failed') return 'error';
  return 'pending'; // pending / scheduled / active / recurring → keep visible + cancellable
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
      const sf =
        typeof it.scheduledFor === 'number'
          ? it.scheduledFor
          : it.scheduledFor
            ? Date.parse(it.scheduledFor)
            : NaN;
      if (!it.payload || !Number.isFinite(sf)) return null;
      return {
        serverId: it.id,
        chatGuid: it.payload.chatGuid,
        text: it.payload.message,
        scheduledFor: sf,
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
  args: SendTextArgs,
): Promise<{ tempGuid: string }> {
  await deleteMessageByGuid(getDatabase(), oldTempGuid);
  return sendTextMessage(getDatabase(), http, args);
}
