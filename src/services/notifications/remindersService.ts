import {
  createReminder,
  deleteReminder,
  getMessageDateByGuid,
  getReminderByMessageGuid,
  updateReminderTime,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import type { Reminder } from '@core/models';
import { logger } from '@core/secure';
import { cancelReminderNotification, scheduleReminderNotification } from './notifeeService';
import { isSafeReminderNotificationId, newReminderNotificationId } from './notificationRouting';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';

/** The Notifee side, injectable so the scheduling logic is Node-testable. */
export interface ReminderScheduler {
  schedule(args: {
    notificationId: string;
    chatGuid: string;
    messageGuid: string;
    title: string;
    body: string;
    scheduledFor: number;
    messageDate?: number;
  }): Promise<void>;
  cancel(notificationId: string): Promise<void>;
}

const notifeeScheduler: ReminderScheduler = {
  schedule: scheduleReminderNotification,
  cancel: cancelReminderNotification,
};

/** A reminder action was retired by Disconnect before it could safely finish. */
export class ReminderSessionChangedError extends Error {
  constructor() {
    super('Reminder operation stopped because the account session changed');
    this.name = 'ReminderSessionChangedError';
  }
}

function assertReminderLease(lease: RealtimeDeliveryLease): void {
  if (!lease.isCurrent()) throw new ReminderSessionChangedError();
}

/**
 * Keep the complete DB → native → DB sequence visible to Disconnect's drain. A candidate
 * trigger id may be supplied for cleanup: native scheduling can finish just after revocation, and
 * cancelling that id is safe even when scheduling actually failed or the trigger already fired.
 */
async function runReminderAccountOperation<T>(
  lease: RealtimeDeliveryLease,
  task: () => Promise<T>,
  scheduler: ReminderScheduler,
  candidateTrigger: () => string | null,
): Promise<T> {
  let completed = false;
  let result!: T;
  let revokedCleanupAttempted = false;
  const cleanupRevokedCandidate = async (): Promise<void> => {
    if (revokedCleanupAttempted) return;
    revokedCleanupAttempted = true;
    const notificationId = candidateTrigger();
    if (notificationId != null) await retireTrigger(scheduler, notificationId);
  };
  try {
    const status = await runTrackedRealtimeWork(lease, async () => {
      assertReminderLease(lease);
      try {
        result = await task();
        assertReminderLease(lease);
        completed = true;
      } catch (error) {
        if (!lease.isCurrent()) {
          // Keep the compensating native cancel inside the admitted drain slot. Otherwise
          // Disconnect could observe this task as idle while its late trigger cleanup was still
          // crossing the bridge.
          await cleanupRevokedCandidate();
          throw new ReminderSessionChangedError();
        }
        throw error;
      }
    });
    // Disconnect can invalidate the lease in the promise handoff after `task`'s final assertion
    // but before this continuation runs. Treat that narrow window as retired too, so an old screen
    // cannot report success in the replacement account; teardown still wipes the completed write.
    if (status === 'paused' || !completed || !lease.isCurrent()) {
      await cleanupRevokedCandidate();
      throw new ReminderSessionChangedError();
    }
    return result;
  } catch (error) {
    if (!lease.isCurrent()) {
      // Covers a rejected admission and the tiny handoff after the tracked callback has completed.
      await cleanupRevokedCandidate();
      throw new ReminderSessionChangedError();
    }
    throw error;
  }
}

/**
 * Retire a superseded trigger. Best-effort by design: it runs only AFTER the reminder's durable row
 * already points at the new trigger, so failing here costs at most one stale alarm — whereas
 * letting it throw would report "couldn't set the reminder" for a reminder that is, in fact, set.
 * An unknown/already-fired id is a normal no-op on the notify-kit side.
 */
async function retireTrigger(scheduler: ReminderScheduler, notificationId: string): Promise<void> {
  try {
    await scheduler.cancel(notificationId);
  } catch (e) {
    logger.warn('[reminder] cancelling the superseded trigger failed', e);
  }
}

async function retireUncertainTrigger(
  scheduler: ReminderScheduler,
  notificationId: string,
  originalError: unknown,
): Promise<void> {
  try {
    await scheduler.cancel(notificationId);
  } catch (cleanupError) {
    throw new Error(
      `could not retire an uncertain reminder trigger (${String(originalError)}; ${String(cleanupError)})`,
    );
  }
}

export interface ScheduleReminderArgs {
  chatGuid: string;
  messageGuid: string;
  chatTitle: string;
  messagePreview: string | null;
  senderName: string | null;
  scheduledFor: number;
  now?: number;
}

/**
 * Schedule (or replace) a reminder for a message — one reminder per message. Returns its id.
 *
 * ORDER IS THE WHOLE POINT: arm the new trigger, persist the row, retire the old trigger.
 *
 * A reminder is two halves — a durable row and a system alarm that outlives it — and every
 * ordering except this one can leave the user holding just one of them. Cancelling and deleting the
 * previous reminder up front (the old shape) meant a `schedule` that threw destroyed a perfectly
 * good reminder and left NONE, behind a dialog that reads like nothing changed. Arming first makes
 * that failure a true no-op. Persisting before retiring the old trigger then makes the whole thing
 * all-or-nothing: any throw rewinds to exactly the previous state.
 */
export async function scheduleReminder(
  db: AppDatabase,
  args: ScheduleReminderArgs,
  scheduler: ReminderScheduler = notifeeScheduler,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<number> {
  let candidateNotificationId: string | null = null;
  return runReminderAccountOperation(
    accountLease,
    async () => {
      assertReminderLease(accountLease);
      const existing = await getReminderByMessageGuid(db, args.messageGuid);
      assertReminderLease(accountLease);
      let notificationId: string;
      if (
        existing?.scheduledFor === args.scheduledFor &&
        isSafeReminderNotificationId(existing.notificationId)
      ) {
        notificationId = existing.notificationId;
      } else {
        notificationId = await newReminderNotificationId(db, args.messageGuid, args.scheduledFor);
        assertReminderLease(accountLease);
      }
      candidateNotificationId = notificationId;
      // Re-picking the same minute yields the same id, so `schedule` re-arms the SAME trigger in place.
      // Retiring "the old" one would then cancel the one we just armed — and the failure path must not
      // cancel it either, since the pre-existing row still depends on it.
      const rearmedInPlace = existing != null && existing.notificationId === notificationId;
      // Look up the reminded message's date so the notification tap can center the chat on it
      // (?focusDate deep-link). null when the message is gone — the tap still opens the chat.
      const messageDate = (await getMessageDateByGuid(db, args.messageGuid)) ?? undefined;
      assertReminderLease(accountLease);
      try {
        await scheduler.schedule({
          notificationId,
          chatGuid: args.chatGuid,
          messageGuid: args.messageGuid,
          title: args.chatTitle,
          body: args.messagePreview ?? 'Reminder',
          scheduledFor: args.scheduledFor,
          messageDate,
        });
      } catch (error) {
        if (!rearmedInPlace) await retireUncertainTrigger(scheduler, notificationId, error);
        throw error;
      }
      assertReminderLease(accountLease);

      let id: number | null = null;
      try {
        // MOVE the existing row rather than delete-and-recreate it: the Reminders list is a reactive
        // query and every write wakes it, so a delete-then-insert genuinely renders "No reminders" in
        // between. Match the notification id we read before crossing the native bridge. If another
        // operation changed or deleted that row while scheduling, this older operation must retire its
        // candidate instead of overwriting the newer reminder or creating a duplicate row.
        // (The moved row keeps its original preview text; the notification body the user actually sees
        // was just re-baked from the fresh preview above.)
        if (existing) {
          const moved = await updateReminderTime(
            db,
            existing.id,
            args.scheduledFor,
            notificationId,
            () => accountLease.isCurrent(),
            existing.notificationId,
          );
          if (!moved) throw new Error('reminder no longer matches');
          id = existing.id;
        }
        assertReminderLease(accountLease);
        if (id == null) {
          id = await createReminder(
            db,
            {
              messageGuid: args.messageGuid,
              chatGuid: args.chatGuid,
              messagePreview: args.messagePreview,
              senderName: args.senderName,
              scheduledFor: args.scheduledFor,
              notificationId,
              createdAt: args.now ?? null,
            },
            () => accountLease.isCurrent(),
          );
          assertReminderLease(accountLease);
        }
      } catch (e) {
        // The durable half failed after the alarm was armed. Un-arm it, or it fires with no row behind
        // it — unlistable and uncancellable during the live session. Disconnect's broad native
        // cancellation is a backstop, but normal reminder management still needs a durable row.
        if (!rearmedInPlace) await retireUncertainTrigger(scheduler, notificationId, e);
        throw e;
      }
      if (existing && !rearmedInPlace) await retireTrigger(scheduler, existing.notificationId);
      assertReminderLease(accountLease);
      return id;
    },
    scheduler,
    () => candidateNotificationId,
  );
}

/** Cancel + delete a reminder (the Notifee trigger and the DB row). */
export async function cancelReminder(
  db: AppDatabase,
  reminder: Pick<Reminder, 'id' | 'notificationId'>,
  scheduler: ReminderScheduler = notifeeScheduler,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  await runReminderAccountOperation(
    accountLease,
    async () => {
      assertReminderLease(accountLease);
      await scheduler.cancel(reminder.notificationId);
      assertReminderLease(accountLease);
      const deleted = await deleteReminder(
        db,
        reminder.id,
        () => accountLease.isCurrent(),
        reminder.notificationId,
      );
      assertReminderLease(accountLease);
      if (!deleted) throw new Error('reminder no longer matches');
    },
    scheduler,
    () => null,
  );
}

/**
 * Move a reminder to a new time. Same order as {@link scheduleReminder}: arm, persist, retire.
 * Throws when the reminder no longer exists, so the caller reports a failure instead of a lie.
 */
export async function rescheduleReminder(
  db: AppDatabase,
  reminder: Reminder,
  scheduledFor: number,
  scheduler: ReminderScheduler = notifeeScheduler,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<string> {
  let candidateNotificationId: string | null = null;
  return runReminderAccountOperation(
    accountLease,
    async () => {
      assertReminderLease(accountLease);
      const notificationId = await newReminderNotificationId(
        db,
        reminder.messageGuid,
        scheduledFor,
      );
      assertReminderLease(accountLease);
      candidateNotificationId = notificationId;
      const messageDate = (await getMessageDateByGuid(db, reminder.messageGuid)) ?? undefined;
      assertReminderLease(accountLease);
      const rearmedInPlace = reminder.notificationId === notificationId;
      // Schedule the new trigger FIRST so a failure leaves the old reminder intact
      // (no orphaned DB row pointing at a cancelled trigger).
      try {
        await scheduler.schedule({
          notificationId,
          chatGuid: reminder.chatGuid,
          messageGuid: reminder.messageGuid,
          title: reminder.senderName ?? 'Reminder',
          body: reminder.messagePreview ?? 'Reminder',
          scheduledFor,
          messageDate,
        });
      } catch (error) {
        if (!rearmedInPlace) await retireUncertainTrigger(scheduler, notificationId, error);
        throw error;
      }
      assertReminderLease(accountLease);

      let moved: boolean;
      try {
        moved = await updateReminderTime(
          db,
          reminder.id,
          scheduledFor,
          notificationId,
          () => accountLease.isCurrent(),
          reminder.notificationId,
        );
        assertReminderLease(accountLease);
      } catch (e) {
        if (!rearmedInPlace) await retireUncertainTrigger(scheduler, notificationId, e);
        throw e;
      }
      // `reminder` is a snapshot the screen captured BEFORE the time picker opened — a dialog that can
      // sit there for minutes — so by now the row may have been deleted from that same screen. The
      // update reports that (0 rows) instead of silently succeeding; without acting on it we would walk
      // away having armed an alarm for a reminder that no longer exists: it still fires, the Reminders
      // screen can neither show nor cancel it. Disconnect's broad native cancellation is a final
      // backstop, but normal in-session cleanup still needs the durable row to target it.
      if (!moved) {
        const missing = new Error('reminder no longer exists');
        await retireUncertainTrigger(scheduler, notificationId, missing);
        throw missing;
      }
      if (!rearmedInPlace) await retireTrigger(scheduler, reminder.notificationId);
      assertReminderLease(accountLease);
      return notificationId;
    },
    scheduler,
    () => candidateNotificationId,
  );
}
