import * as scheduledApi from '@core/api/endpoints/scheduled';
import { logger } from '@core/secure';
import { getDatabase } from '@db/database';
import {
  claimFailedOutgoingForRetryWithinTransaction,
  countOutgoingQueueHealth,
  deleteMessageLocalWithinTransaction,
  deleteScheduledWithinTransaction,
  discardOutgoingMessageWithinTransaction,
  getScheduledById,
  listServerScheduledPruneExposure,
  reconcileServerScheduled,
  updateScheduled,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { http } from '../clients';
import { sendTextMessage, type SendTextArgs } from './sendService';
import { sendReactionMessage, type SendReactionArgs } from './sendReactionService';
import { sendEdit, sendUnsend } from './sendEditService';
import {
  ensureScheduledRecovery,
  runDueScheduled,
  scheduleTextMessage,
  ScheduledSessionChangedError,
  type ScheduleArgs,
} from './scheduleService';
import { sendImageMessage, type PickedImage } from './sendAttachmentService';
import { sendContactMessage, hasContactContent, type ContactCard } from './sendContactService';
import { pickContact } from '../contacts/contactsService';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';
import { expoAttachmentUploader, expoFileExists } from './attachmentUpload';
import { uploadRegistry } from './uploadControl';
import { resendOutgoingRow, runOutgoingQueue, type OutgoingQueueIO } from './outgoingQueueService';
import { showToast } from '@ui/toast/toastStore';
import { createAttachmentCacheAccountScope } from '../download/attachmentCacheAccountScope';
import { attachmentCacheCoordinator } from '../download/attachmentCacheCoordinator';
import { logicalSendQueue, LogicalSendQueueCapacityError } from './logicalSendQueue';
import { clearFailedSendNotice } from './sendFailureNotice';

export { isContactsPermissionDeniedError } from '../contacts/contactsService';
export { runOutgoingQueue, type OutgoingQueueIO } from './outgoingQueueService';

function snapshotPickedImage(image: PickedImage): PickedImage {
  return { ...image };
}

function snapshotContactCard(contact: ContactCard): ContactCard {
  return {
    ...contact,
    phones: contact.phones?.map((phone) => ({ ...phone })),
    emails: contact.emails?.map((email) => ({ ...email })),
  };
}

function snapshotSendTextArgs(args: SendTextArgs): SendTextArgs {
  return {
    ...args,
    mentions: args.mentions?.map((mention) => ({ ...mention })),
  };
}

/**
 * Composer preflight for one synchronous submit turn. The composer checks the whole attachment +
 * text submission before it clears the authored draft, then immediately calls the send front
 * doors, whose queue admission is synchronous.
 */
export function hasLogicalSendCapacity(logicalSendCount = 1): boolean {
  return logicalSendQueue.canRetain(logicalSendCount);
}

function assertScheduledLease(lease: RealtimeDeliveryLease): void {
  if (!lease.isCurrent()) throw new ScheduledSessionChangedError();
}

/**
 * Publish one whole scheduled-message action to Disconnect's drain while retaining its real return
 * value. The coordinator intentionally returns only delivered/paused, so this tiny adapter keeps
 * the result in the admitted callback and converts a rejected admission into the same clear error
 * used by mid-flight ownership checks.
 */
async function runScheduledAccountOperation<T>(
  lease: RealtimeDeliveryLease,
  task: () => Promise<T>,
): Promise<T> {
  let completed = false;
  let result!: T;
  const status = await runTrackedRealtimeWork(lease, async () => {
    assertScheduledLease(lease);
    try {
      result = await task();
      assertScheduledLease(lease);
      completed = true;
    } catch (error) {
      // Prefer the ownership error when the underlying await failed because Disconnect reset its
      // HTTP/native/DB dependency. Otherwise callers would report a misleading offline failure.
      assertScheduledLease(lease);
      throw error;
    }
  });
  if (status === 'paused' || !completed || !lease.isCurrent()) {
    throw new ScheduledSessionChangedError();
  }
  return result;
}

/**
 * Keep one user-initiated send/mutation visible to Disconnect from before its first await until
 * its last DB/native/network continuation settles. A stale screen callback is deliberately a
 * quiet `null`: it belongs to the retired account, so it must neither act with the next account's
 * dependencies nor surface an old-account error in the new UI.
 *
 * Unlike scheduled actions, ordinary composer/menu callbacks are fire-and-forget and have no
 * useful error UI for an account switch. Current-account failures still reject unchanged.
 */
async function runUiAccountOperation<T>(
  lease: RealtimeDeliveryLease,
  task: () => Promise<T>,
  mode: 'immediate' | 'logical-send' = 'immediate',
): Promise<T | null> {
  let completed = false;
  let result!: T;
  try {
    const status = await runTrackedRealtimeWork(lease, async () => {
      if (!lease.isCurrent()) return;
      result = await (mode === 'logical-send' ? logicalSendQueue.run(lease, task) : task());
      if (!lease.isCurrent()) return;
      completed = true;
    });
    if (status === 'paused' || !completed || !lease.isCurrent()) return null;
    return result;
  } catch (error) {
    if (!lease.isCurrent()) return null;
    if (error instanceof LogicalSendQueueCapacityError) {
      showToast('Too many messages are waiting—try again in a moment');
      return null;
    }
    throw error;
  }
}

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
export function sendImage(
  args: {
    chatGuid: string;
    image: PickedImage;
  },
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<{
  tempGuid: string;
} | null> {
  const snapshot = {
    chatGuid: args.chatGuid,
    image: snapshotPickedImage(args.image),
  };
  return runUiAccountOperation(
    accountLease,
    () =>
      sendImageMessage(getDatabase(), http, snapshot, expoAttachmentUploader, Date.now(), () =>
        accountLease.isCurrent(),
      ),
    'logical-send',
  );
}

/** UI-facing multi-image send: one optimistic message + attachment per picked asset. */
export function sendImages(
  args: {
    chatGuid: string;
    images: PickedImage[];
  },
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<{ tempGuid: string }[] | null> {
  const snapshot = {
    chatGuid: args.chatGuid,
    images: args.images.map(snapshotPickedImage),
  };
  return runUiAccountOperation(
    accountLease,
    async () => {
      const settled = await Promise.allSettled(
        snapshot.images.map((image) =>
          sendImageMessage(
            getDatabase(),
            http,
            { chatGuid: snapshot.chatGuid, image },
            expoAttachmentUploader,
            Date.now(),
            () => accountLease.isCurrent(),
          ),
        ),
      );
      // Promise.all rejects as soon as ONE item fails and would release the account drain while the
      // other native uploads keep running. Wait for every operation we started, then preserve the
      // original current-account failure behavior.
      const sent: { tempGuid: string }[] = [];
      for (const outcome of settled) {
        if (outcome.status === 'rejected') throw outcome.reason;
        sent.push(outcome.value);
      }
      return sent;
    },
    'logical-send',
  );
}

/** UI-facing send: bound to the composition-root DB + HttpClient. */
export function send(
  args: SendTextArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<{ tempGuid: string } | null> {
  const snapshot = snapshotSendTextArgs(args);
  return runUiAccountOperation(
    accountLease,
    () => sendTextMessage(getDatabase(), http, snapshot),
    'logical-send',
  );
}

/** UI-facing contact-card send: bound to the composition-root DB + HttpClient. */
export function sendContactCard(
  args: {
    chatGuid: string;
    contact: ContactCard;
    replyToGuid?: string;
  },
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<{
  tempGuid: string;
} | null> {
  const snapshot = {
    chatGuid: args.chatGuid,
    contact: snapshotContactCard(args.contact),
    replyToGuid: args.replyToGuid,
  };
  return runUiAccountOperation(
    accountLease,
    () =>
      sendContactMessage(getDatabase(), http, {
        chatGuid: snapshot.chatGuid,
        contact: snapshot.contact,
        selectedMessageGuid: snapshot.replyToGuid,
      }),
    'logical-send',
  );
}

/**
 * UI-facing "share a contact" flow: open the native picker, then send the chosen contact as a
 * card. Returns null when the user cancels the picker or the contact has no usable field. A denied
 * Contacts grant rejects with `ContactsPermissionDeniedError` so the screen can explain recovery.
 * Kept here (not in the chat screen) so the screen depends only on the send barrel — and so the
 * expo-contacts native import stays out of the screen's module graph.
 */
export async function pickAndSendContact(
  chatGuid: string,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<{ tempGuid: string } | null> {
  if (!accountLease.isCurrent()) return null;
  // The native picker may sit open for minutes, but has not touched account data yet. Keep it
  // outside the Disconnect drain, then validate the screen's PRE-picker lease before admitting the
  // actual DB/send operation. This avoids either failure mode: blocking account cleanup on an OS
  // sheet, or letting that old sheet return and capture B.
  let contact: Awaited<ReturnType<typeof pickContact>>;
  try {
    contact = await pickContact();
  } catch (error) {
    if (!accountLease.isCurrent()) return null;
    throw error;
  }
  if (!accountLease.isCurrent() || !contact || !hasContactContent(contact)) return null;
  const snapshot = snapshotContactCard(contact);
  return runUiAccountOperation(
    accountLease,
    () => sendContactMessage(getDatabase(), http, { chatGuid, contact: snapshot }),
    'logical-send',
  );
}

/** UI-facing tapback send (toggle: pass '-love' to remove). */
export function react(
  args: SendReactionArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<{ tempGuid: string } | null> {
  const snapshot = { ...args };
  return runUiAccountOperation(
    accountLease,
    () => sendReactionMessage(getDatabase(), http, snapshot),
    'logical-send',
  );
}

/** UI-facing threaded reply: a text send whose reply target is `replyToGuid`. */
export function reply(
  args: {
    chatGuid: string;
    text: string;
    replyToGuid: string;
    effectId?: string;
  },
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<{
  tempGuid: string;
} | null> {
  const snapshot = { ...args };
  return runUiAccountOperation(
    accountLease,
    () =>
      sendTextMessage(getDatabase(), http, {
        chatGuid: snapshot.chatGuid,
        text: snapshot.text,
        selectedMessageGuid: snapshot.replyToGuid,
        effectId: snapshot.effectId,
      }),
    'logical-send',
  );
}

/** UI-facing edit of a sent message's text (optimistic + revert on failure). */
export function editText(
  args: {
    messageGuid: string;
    newText: string;
    chatGuid?: string;
  },
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<{
  ok: boolean;
} | null> {
  return runUiAccountOperation(accountLease, () => sendEdit(getDatabase(), http, args));
}

/** UI-facing unsend/retract of a sent message. */
export function unsend(
  args: { messageGuid: string; chatGuid?: string },
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<{ ok: boolean } | null> {
  return runUiAccountOperation(accountLease, () => sendUnsend(getDatabase(), http, args));
}

/** UI-facing: store a message to send later (server-side when possible). */
export function schedule(
  args: ScheduleArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<{ id: number; serverId: string | null }> {
  return runScheduledAccountOperation(accountLease, () =>
    scheduleTextMessage(getDatabase(), http, args, accountLease),
  );
}

/**
 * Cancel a scheduled message. For a server-backed row the SERVER delete must succeed FIRST —
 * if it fails we keep the local row and rethrow (the message is still scheduled server-side,
 * so the user must be able to retry the cancel rather than lose the only handle to it).
 */
export async function cancelScheduled(
  row: { id: number; serverId: string | null },
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  const db = getDatabase();
  const id = row.id;
  const serverId = row.serverId;
  await runScheduledAccountOperation(accountLease, async () => {
    assertScheduledLease(accountLease);
    if (serverId != null) {
      await scheduledApi.deleteScheduled(http, serverId); // throws → local kept, UI alerts
      assertScheduledLease(accountLease);
    }
    await withDbTransaction(
      db,
      (context) => deleteScheduledWithinTransaction(context, id),
      () => accountLease.isCurrent(),
    );
    assertScheduledLease(accountLease);
  });
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
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  await runScheduledAccountOperation(accountLease, async () => {
    const db = getDatabase();
    assertScheduledLease(accountLease);
    const row = await getScheduledById(db, id);
    assertScheduledLease(accountLease);
    if (row?.serverId != null) {
      // No PUT on Gator: delete the old server-side message, then create a replacement.
      await scheduledApi.deleteScheduled(http, row.serverId); // throws → local untouched, UI alerts
      assertScheduledLease(accountLease);
      if (patch.recurrence) {
        // Now recurring → keep it local-only so the ticker (which skips server-backed rows)
        // fires and re-arms it. The server row is already gone; just drop the serverId.
        await updateScheduled(db, id, { ...patch, serverId: null });
        assertScheduledLease(accountLease);
        return;
      }
      let newServerId: string | null;
      try {
        const created = await scheduledApi.createScheduled(http, {
          chatGuid: row.chatGuid,
          message: patch.text,
          scheduledFor: patch.scheduledFor ?? row.scheduledFor,
        });
        assertScheduledLease(accountLease);
        newServerId = created?.id ?? null;
      } catch (e) {
        // A revoked A request must not turn into a B-local fallback row.
        assertScheduledLease(accountLease);
        // DELETE succeeded but the re-create failed: the old server message is gone. DROP the
        // serverId so the on-device worker fires the edited message as a fallback (rather than
        // orphaning it — a non-null serverId would make the local worker skip it forever), apply
        // the edit locally, then surface the failure.
        await updateScheduled(db, id, { ...patch, serverId: null });
        assertScheduledLease(accountLease);
        throw e;
      }
      // Repoint the local row at the fresh uuid alongside the text/time change.
      await updateScheduled(db, id, { ...patch, serverId: newServerId });
      assertScheduledLease(accountLease);
      return;
    }
    await updateScheduled(db, id, patch);
    assertScheduledLease(accountLease);
  });
}

/** Gator scheduled status (pending|sent|failed) → local {pending,sent,error} so pending rows stay visible. */
function normalizeSchedStatus(s: string | null | undefined): string {
  const v = (s ?? '').toLowerCase();
  if (v === 'complete' || v === 'completed' || v === 'sent') return 'sent';
  if (v === 'error' || v === 'failed') return 'error';
  return 'pending'; // pending / scheduled → keep visible + cancellable
}

/** Pull the server's scheduled list into the local DB (keeps server-backed rows accurate). */
export async function syncScheduledFromServer(
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  try {
    await runScheduledAccountOperation(accountLease, async () => {
      const db = getDatabase();
      // Snapshot which rows this reconcile is ALLOWED to prune BEFORE the round trip. The server's
      // answer describes the instant it was built, and the Scheduled screen's Edit re-creates a
      // server-side message (delete + POST) — a row created while the GET was in flight is missing
      // from that answer through no fault of its own, and pruning it deletes the local handle to a
      // message the server will still fire.
      const pruneExposure = await listServerScheduledPruneExposure(db, () =>
        accountLease.isCurrent(),
      );
      assertScheduledLease(accountLease);
      let items: Awaited<ReturnType<typeof scheduledApi.getScheduled>>;
      try {
        items = await scheduledApi.getScheduled(http);
      } catch {
        assertScheduledLease(accountLease);
        return; // older/offline server — keep local rows as-is
      }
      assertScheduledLease(accountLease);
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
      assertScheduledLease(accountLease);
      await reconcileServerScheduled(db, mapped, serverIds, {
        pruneExposure,
        commitGuard: () => accountLease.isCurrent(),
      });
      assertScheduledLease(accountLease);
    });
  } catch (error) {
    // This is called fire-and-forget on screen mount. A deliberate Disconnect is a quiet no-op,
    // not an unhandled rejection in the newly connected UI.
    if (error instanceof ScheduledSessionChangedError) return;
    throw error;
  }
}

/** Fire any scheduled messages now due (real send path). */
export async function fireDueScheduled(now = Date.now()): Promise<number> {
  const accountLease = captureRealtimeDeliveryLease();
  try {
    return await runScheduledAccountOperation(accountLease, () =>
      runDueScheduled(getDatabase(), http, now, undefined, accountLease),
    );
  } catch (error) {
    if (error instanceof ScheduledSessionChangedError) return 0;
    throw error;
  }
}

/** Join the once-per-account recovery barrier for rows interrupted mid-send. */
export async function recoverStuckScheduled(): Promise<number> {
  const accountLease = captureRealtimeDeliveryLease();
  try {
    return await runScheduledAccountOperation(accountLease, () =>
      ensureScheduledRecovery(getDatabase(), accountLease),
    );
  } catch (error) {
    if (error instanceof ScheduledSessionChangedError) return 0;
    throw error;
  }
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
  // Capture before the health-check await. An old recovery callback must never turn into a B-account
  // drain merely because Disconnect + reconnect completed while that read was in flight.
  const accountLease = captureRealtimeDeliveryLease();
  if (!accountLease.isCurrent()) return { eligible: 0, sent: 0 };
  // Before the drain, so the counts describe what the last session left behind rather than what
  // this one just repaired. Gated to the first call, which is the boot drain.
  await reportQueueHealthOnce();
  return runOutgoingQueue(getDatabase(), http, outgoingQueueIO, now, accountLease);
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
 * seconds (a foreground attachment upload has no timeout), while the sheet the user is tapping opened
 * before any of that. Only an 'error' row with a live ladder is ours; anything else says so and
 * re-sends nothing.
 */
export async function retry(
  tempGuid: string,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  if (!accountLease.isCurrent()) return;
  // NEVER rejects. The only call site is a `void retry(...)` in a press handler, so a rejection
  // here is an unhandled promise: no toast, no log, a tap that visibly did nothing. The bubble and
  // its ladder survive any failure now, so there is nothing to repair — only something to report.
  try {
    await runUiAccountOperation(accountLease, async () => {
      const db = getDatabase();
      const { claim, row } = await withDbTransaction(
        db,
        (context) => claimFailedOutgoingForRetryWithinTransaction(context, tempGuid, Date.now),
        () => accountLease.isCurrent(),
      );
      if (!accountLease.isCurrent()) return;
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
      const outcome = await resendOutgoingRow(
        db,
        http,
        outgoingQueueIO,
        row,
        () => Date.now(),
        accountLease,
      );
      if (!accountLease.isCurrent()) return;
      // Retired for good: the attachment's on-disk file is gone, so no re-send can ever work. The
      // bubble keeps its error badge (Delete on the sheet still works) — say why rather than leave
      // the tap looking like it did nothing.
      if (outcome === 'unsendable') showToast('Original file is no longer available');
    });
  } catch (e) {
    // Disconnect may have revoked this retry while a DB/native await was in flight. An A-account
    // failure must not surface as a toast in B's newly connected UI (or as a misleading warning).
    if (!accountLease.isCurrent()) return;
    // A DB/driver failure in the claim itself. The automatic ladder still owns the row.
    logger.warn('[send] manual retry failed', e);
    showToast('Couldn’t retry — try again in a moment');
  }
}

/**
 * Discard a message from the user's "Delete" (single or bulk), whatever state it is in.
 *
 * ONE guarded transaction with two branches covers every state exactly once:
 *  1. `discardOutgoingMessageWithinTransaction` claims ONLY an unconfirmed optimistic row (a `temp-` guid still
 *     'sending' or 'error'): it tombstones the bubble and takes its queue row with it, so the
 *     retry ladder can't re-POST what the user just removed.
 *  2. Everything else — a real server guid, and a `temp-` row already flipped to 'sent' by a
 *     guid-less ack (RCS / AppleScript) — falls through to
 *     `deleteMessageLocalWithinTransaction` before the same commit.
 * BOTH steps tombstone; the difference is only which one owns the queue row and the ownership
 * answer the caller gets. Every state here is a message the server may still have, and a hard
 * delete of any of them is undone the next time the thread syncs (`ensureChatSynced` re-pages 500
 * messages on EVERY chat open) — `date_deleted` is the only thing that survives that.
 * The step-1 helper returning "I cleaned something up" instead of "I own this message" is what
 * made a Delete silently do nothing, so it now reports ownership only.
 */
export async function discardMessage(
  guid: string,
  now: number = Date.now(),
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  await runUiAccountOperation(accountLease, async () => {
    // STOP THE BYTES FIRST, before either tombstone. "Cancel Sending" used to be a pure DB write:
    // the bubble vanished while the phone carried on streaming the entire file to the server — on a
    // large video, for minutes, over the user's data. The upload simply had no cancel handle to
    // reach for. Cancelling is safe for every other message kind too: nothing is registered under a
    // text/reaction/contact temp guid, so this is a no-op for them.
    uploadRegistry.cancel(guid);
    const db = getDatabase();
    const attachmentCacheScope = createAttachmentCacheAccountScope(accountLease);
    const result = await withDbTransaction(
      db,
      async (context) => {
        const outgoingOwned = await discardOutgoingMessageWithinTransaction(context, guid, now);
        return outgoingOwned ? null : deleteMessageLocalWithinTransaction(context, guid, now);
      },
      () => accountLease.isCurrent(),
    );
    if (!accountLease.isCurrent()) return;
    if (result === 'unresolved-temp') {
      // The fixed-size alias ledger may have retired an extremely old mapping. Never claim the
      // destructive action succeeded against an identity we cannot prove; the reactive list now
      // carries the real GUID, so selecting the message again gives the user a safe retry.
      showToast('Message changed—select it again');
    }
    if (!accountLease.isCurrent()) return;
    // The tombstone commits before native mutation. Failed-send notices are keyed by the retained
    // local message id, so removing the bubble must also withdraw its already-posted tray record.
    await clearFailedSendNotice(db, guid, () => accountLease.isCurrent());
    if (!accountLease.isCurrent()) return;
    // Tombstone + ledger/ref changes committed above. Exact native deletion stays outside their DB
    // transaction and inside this account-scoped operation, so Disconnect drains it before wipe.
    await attachmentCacheCoordinator
      .retireInactiveEntries(db, { scope: attachmentCacheScope })
      .catch((error) => logger.debug('[send] deleted-message cache retirement deferred', error));
    await attachmentCacheCoordinator
      .drainDueRetirements(db, { scope: attachmentCacheScope })
      .catch((error) => logger.debug('[send] deleted-message cache cleanup deferred', error));
  });
}

/*
 * There is deliberately NO `cancelOutgoing` wrapper here any more. "Cancel Sending" and "Remove"
 * are worded differently but ask for the same thing, and routing them at only
 * `discardOutgoingMessage` made the tap a SILENT NO-OP whenever the send completed while the
 * confirmation dialog was on screen (seconds — the guard then matches nothing and the boolean is
 * discarded). Every user-facing removal goes through {@link discardMessage}, whose second step
 * removes what the first does not own.
 */
