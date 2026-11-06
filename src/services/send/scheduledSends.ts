/** Scheduled sends of the send front door (moved from index.ts): schedule, cancel, edit, server sync. The due-schedule drains stay in index.ts where the scheduled-recovery guard pins them. */

import * as scheduledApi from '@core/api/endpoints/scheduled';
import { ApiError } from '@core/api/errors';
import {
  isSupportedImessageAttachmentType,
  MAX_IMESSAGE_SCHEDULED_ATTACHMENT_BYTES,
} from '@core/models/serverInfo';
import { getDatabase } from '@db/database';
import {
  cancelPendingScheduledWithinTransaction,
  deleteScheduledHistoryWithinTransaction,
  getScheduledById,
  listServerScheduledPruneExposure,
  reconcileServerScheduled,
  type ScheduledCancellationTarget,
  type ScheduledOccurrence,
  type UpdateScheduledPatch,
  updateScheduledWithinTransaction,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { isRcsChatGuid } from '@utils/chat';
import { accountHttp } from '../clients';
import {
  type ScheduleArgs,
  type ScheduleAttachmentArgs,
  scheduleAttachmentMessage,
  ScheduledSessionChangedError,
  scheduleTextMessage,
} from './scheduleService';
import type { PickedImage } from './sendAttachmentService';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';
import { captureSessionRcsCapabilityLease } from './rcsAttemptCapability';
import {
  assertScheduledLease,
  assertScheduledMutationCurrent,
  captureScheduledChatMutationGuard,
  runScheduledAccountOperation,
  snapshotPickedImage,
} from './sendShared';

/** UI-facing: store a message to send later (server-side when possible). */
export function schedule(
  args: ScheduleArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<{ id: number; serverId: string | null }> {
  return runScheduledAccountOperation(accountLease, () => {
    const capability = captureSessionRcsCapabilityLease();
    return scheduleTextMessage(
      getDatabase(),
      accountHttp(accountLease),
      args,
      accountLease,
      capability,
    );
  });
}
/** Server-owned, one-time file schedule; failure never starts the phone's text fallback. */
export function scheduleAttachment(
  args: { chatGuid: string; text: string; scheduledFor: number; attachment: PickedImage },
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<{ id: number; serverId: string }> {
  const snapshot = { ...args, attachment: snapshotPickedImage(args.attachment) };
  return runScheduledAccountOperation(accountLease, async () => {
    const capability = captureSessionRcsCapabilityLease();
    if (isRcsChatGuid(snapshot.chatGuid)) {
      throw new Error('Scheduled attachments are available only in iMessage conversations.');
    }
    if (
      capability?.serverInfo?.supports_imessage_scheduled_attachment !== true ||
      !capability.isCurrent()
    ) {
      throw new Error('Scheduled iMessage attachments are unavailable on this server.');
    }
    const file = snapshot.attachment;
    if (
      !file.uri.startsWith('file://') ||
      !isSupportedImessageAttachmentType(file.mimeType, file.name) ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      file.size > MAX_IMESSAGE_SCHEDULED_ATTACHMENT_BYTES
    ) {
      throw new Error('Choose one local JPEG, PNG, or PDF no larger than 512 KiB.');
    }
    const FileSystem = await import('expo-file-system/legacy');
    assertScheduledLease(accountLease);
    const info = await FileSystem.getInfoAsync(file.uri);
    assertScheduledLease(accountLease);
    if (
      !info.exists ||
      !Number.isSafeInteger(info.size) ||
      info.size <= 0 ||
      info.size > MAX_IMESSAGE_SCHEDULED_ATTACHMENT_BYTES
    ) {
      throw new Error('The selected file is unavailable or larger than 512 KiB.');
    }
    const attachmentData = await FileSystem.readAsStringAsync(file.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    assertScheduledLease(accountLease);
    return scheduleAttachmentMessage(
      getDatabase(),
      accountHttp(accountLease),
      {
        chatGuid: snapshot.chatGuid,
        text: snapshot.text,
        scheduledFor: snapshot.scheduledFor,
        attachmentName: file.name,
        mimeType: file.mimeType,
        attachmentData,
      } satisfies ScheduleAttachmentArgs,
      accountLease,
      capability,
    );
  });
}
/** The displayed occurrence no longer belongs to pending cancellation. */
export class ScheduledCancellationChangedError extends Error {
  constructor() {
    super('Scheduled occurrence changed or already started sending');
    this.name = 'ScheduledCancellationChangedError';
  }
}
/**
 * Cancel a remaining occurrence; this does not recall a message already handed off for sending.
 * A remote delete must succeed or confirm typed absence before the exact pending row is removed.
 * All other failures retain the local handle so cancellation can be retried.
 */
export async function cancelScheduled(
  row: ScheduledCancellationTarget,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  const expected = {
    id: row.id,
    chatGuid: row.chatGuid,
    serverId: row.serverId,
    scheduledFor: row.scheduledFor,
  };
  const db = getDatabase();
  await runScheduledAccountOperation(accountLease, async () => {
    assertScheduledLease(accountLease);
    const stored = await getScheduledById(db, expected.id);
    assertScheduledLease(accountLease);
    if (!stored) return;
    // A phone-only row is removed locally and needs no live RCS identity, so a Google re-pair must
    // not strand it; only a server-backed row needs its current pairing for the remote delete.
    const identityIsCurrent =
      stored.serverId == null ? () => true : captureScheduledChatMutationGuard(stored.chatGuid);
    assertScheduledMutationCurrent(accountLease, identityIsCurrent);
    if (
      stored.status !== 'pending' ||
      stored.serverId !== expected.serverId ||
      stored.scheduledFor !== expected.scheduledFor ||
      stored.chatGuid !== expected.chatGuid
    ) {
      throw new ScheduledCancellationChangedError();
    }
    const serverId = stored.serverId;
    if (serverId != null) {
      try {
        await scheduledApi.deleteScheduled(accountHttp(accountLease), serverId);
      } catch (error) {
        // The Mac's exact typed absence is idempotent cancellation, never a generic 404.
        if (!(
          error instanceof ApiError &&
          error.status === 404 &&
          error.serverErrorType === 'scheduled_message_not_found'
        ))
          throw error;
      }
      assertScheduledMutationCurrent(accountLease, identityIsCurrent);
    }
    const result = await withDbTransaction(
      db,
      (db, context) => cancelPendingScheduledWithinTransaction(context, expected),
      () => accountLease.isCurrent() && identityIsCurrent(),
    );
    assertScheduledMutationCurrent(accountLease, identityIsCurrent);
    if (result === 'changed') throw new ScheduledCancellationChangedError();
  });
}
/** Remove one completed scheduled-message history row through the scheduled service boundary. */
export function clearScheduledHistoryItem(
  id: number,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  return runScheduledAccountOperation(accountLease, async () => {
    const db = getDatabase();
    assertScheduledLease(accountLease);
    const stored = await getScheduledById(db, id);
    assertScheduledLease(accountLease);
    if (!stored) return;
    // Clearing history deletes only the local row; a phone-only one needs no live RCS identity.
    const identityIsCurrent =
      stored.serverId == null ? () => true : captureScheduledChatMutationGuard(stored.chatGuid);
    assertScheduledMutationCurrent(accountLease, identityIsCurrent);
    await withDbTransaction(
      db,
      (db, context) => deleteScheduledHistoryWithinTransaction(context, id),
      () => accountLease.isCurrent() && identityIsCurrent(),
    );
    assertScheduledMutationCurrent(accountLease, identityIsCurrent);
  });
}
/** The occurrence an editor was opened on already fired, re-armed, moved, or was removed. */
export class ScheduledEditChangedError extends Error {
  constructor() {
    super('Scheduled occurrence changed or already started sending');
    this.name = 'ScheduledEditChangedError';
  }
}
/**
 * Edit a scheduled message's text/time. Gator has NO update endpoint, so for a server-backed
 * row we re-create it: DELETE the old scheduled message, POST a fresh one, then point the local
 * row at the new uuid. The server call goes FIRST — any failure rethrows so the edit screen can
 * surface it instead of silently diverging from the server. Local-only rows just update locally.
 * Adding a RECURRENCE to a server-backed row converts it to LOCAL-ONLY (delete server-side, no
 * re-create) — the server can't repeat, so the on-device ticker must own the row to re-arm it.
 *
 * Only the exact `occurrence` the editor loaded may be edited. One that fired (and re-armed) or
 * was removed while the editor was open throws {@link ScheduledEditChangedError}: saving the
 * loaded time onto a re-armed row would send that slot twice, and a sent one-time row would
 * otherwise report a save that changed nothing.
 */
export async function editScheduled(
  occurrence: ScheduledOccurrence,
  patch: { text: string; scheduledFor?: number; recurrence?: string | null },
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  const id = occurrence.id;
  const expected = {
    chatGuid: occurrence.chatGuid,
    serverId: occurrence.serverId,
    scheduledFor: occurrence.scheduledFor,
  };
  await runScheduledAccountOperation(accountLease, async () => {
    const db = getDatabase();
    assertScheduledLease(accountLease);
    const row = await getScheduledById(db, id);
    assertScheduledLease(accountLease);
    if (!row) throw new ScheduledEditChangedError();
    const identityIsCurrent = captureScheduledChatMutationGuard(row.chatGuid);
    const assertMutationCurrent = (): void =>
      assertScheduledMutationCurrent(accountLease, identityIsCurrent);
    const persistPatch = async (localPatch: UpdateScheduledPatch): Promise<void> => {
      const result = await withDbTransaction(
        db,
        (db, context) => updateScheduledWithinTransaction(context, id, localPatch, expected),
        () => accountLease.isCurrent() && identityIsCurrent(),
      );
      if (result !== 'updated') throw new ScheduledEditChangedError();
    };
    assertMutationCurrent();
    if (row.attachmentName) {
      throw new Error('File schedules cannot be edited; cancel and create a new schedule.');
    }
    if (
      row.status !== 'pending' ||
      row.chatGuid !== expected.chatGuid ||
      row.serverId !== expected.serverId ||
      row.scheduledFor !== expected.scheduledFor
    ) {
      throw new ScheduledEditChangedError();
    }
    if (row.serverId != null) {
      // No PUT on Gator: delete the old server-side message, then create a replacement.
      await scheduledApi.deleteScheduled(accountHttp(accountLease), row.serverId); // throws → local untouched, UI alerts
      assertMutationCurrent();
      if (patch.recurrence) {
        // Now recurring → keep it local-only so the ticker (which skips server-backed rows)
        // fires and re-arms it. The server row is already gone; just drop the serverId.
        await persistPatch({ ...patch, serverId: null });
        assertMutationCurrent();
        return;
      }
      let newServerId: string | null;
      try {
        const created = await scheduledApi.createScheduled(accountHttp(accountLease), {
          chatGuid: row.chatGuid,
          message: patch.text,
          scheduledFor: patch.scheduledFor ?? row.scheduledFor,
        });
        assertMutationCurrent();
        newServerId = created?.id ?? null;
      } catch (e) {
        // A revoked A request must not turn into a B-local fallback row.
        assertMutationCurrent();
        // DELETE succeeded but the re-create failed: the old server message is gone. DROP the
        // serverId so the on-device worker fires the edited message as a fallback (rather than
        // orphaning it — a non-null serverId would make the local worker skip it forever), apply
        // the edit locally, then surface the failure.
        await persistPatch({ ...patch, serverId: null });
        assertMutationCurrent();
        throw e;
      }
      // Repoint the local row at the fresh uuid alongside the text/time change.
      await persistPatch({ ...patch, serverId: newServerId });
      assertMutationCurrent();
      return;
    }
    await persistPatch(patch);
    assertMutationCurrent();
  });
}
/** File delivery can be ambiguous after a helper timeout, so a failed file row is not a proved miss. */
function normalizeSchedStatus(s: string | null | undefined, method?: string | null): string {
  const v = (s ?? '').toLowerCase();
  if (v === 'complete' || v === 'completed' || v === 'sent') return 'sent';
  if (v === 'error' || v === 'failed') {
    return method === 'narrow-attachment' ? 'uncertain' : 'error';
  }
  return 'pending'; // pending / scheduled → keep visible + cancellable
}
/** Pull the server's scheduled list into the local DB (keeps server-backed rows accurate). */
export async function syncScheduledFromServer(
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<boolean> {
  try {
    return await runScheduledAccountOperation(accountLease, async () => {
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
        items = await scheduledApi.getScheduled(accountHttp(accountLease));
      } catch {
        assertScheduledLease(accountLease);
        return false; // older/offline server — keep local rows, but do not call them verified
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
            attachmentName: it.attachmentName ?? undefined,
            scheduledFor: it.scheduledFor,
            status: normalizeSchedStatus(it.status, it.method),
          };
        })
        .filter((x): x is NonNullable<typeof x> => x != null);
      assertScheduledLease(accountLease);
      await reconcileServerScheduled(db, mapped, serverIds, {
        pruneExposure,
        commitGuard: () => accountLease.isCurrent(),
      });
      assertScheduledLease(accountLease);
      return true;
    });
  } catch (error) {
    // This is called fire-and-forget on screen mount. A deliberate Disconnect is a quiet no-op,
    // not an unhandled rejection in the newly connected UI.
    if (error instanceof ScheduledSessionChangedError) return false;
    throw error;
  }
}
