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

function newNotificationId(messageGuid: string, scheduledFor: number): string {
  return `reminder-${messageGuid}-${scheduledFor}`;
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
): Promise<number> {
  const existing = await getReminderByMessageGuid(db, args.messageGuid);
  const notificationId = newNotificationId(args.messageGuid, args.scheduledFor);
  // Re-picking the same minute yields the same id, so `schedule` re-arms the SAME trigger in place.
  // Retiring "the old" one would then cancel the one we just armed — and the failure path must not
  // cancel it either, since the pre-existing row still depends on it.
  const rearmedInPlace = existing != null && existing.notificationId === notificationId;
  // Look up the reminded message's date so the notification tap can center the chat on it
  // (?focusDate deep-link). null when the message is gone — the tap still opens the chat.
  const messageDate = (await getMessageDateByGuid(db, args.messageGuid)) ?? undefined;
  await scheduler.schedule({
    notificationId,
    chatGuid: args.chatGuid,
    messageGuid: args.messageGuid,
    title: args.chatTitle,
    body: args.messagePreview ?? 'Reminder',
    scheduledFor: args.scheduledFor,
    messageDate,
  });

  let id: number | null = null;
  try {
    // MOVE the existing row rather than delete-and-recreate it: the Reminders list is a reactive
    // query and every write wakes it, so a delete-then-insert genuinely renders "No reminders" in
    // between. A zero-row move means it was cancelled while the time picker sat open — fall through
    // to an insert so the trigger we just armed always has a row behind it.
    // (The moved row keeps its original preview text; the notification body the user actually sees
    // was just re-baked from the fresh preview above.)
    if (
      existing &&
      (await updateReminderTime(db, existing.id, args.scheduledFor, notificationId))
    ) {
      id = existing.id;
    }
    if (id == null) {
      id = await createReminder(db, {
        messageGuid: args.messageGuid,
        chatGuid: args.chatGuid,
        messagePreview: args.messagePreview,
        senderName: args.senderName,
        scheduledFor: args.scheduledFor,
        notificationId,
        createdAt: args.now ?? null,
      });
    }
  } catch (e) {
    // The durable half failed after the alarm was armed. Un-arm it, or it fires with no row behind
    // it — unlistable, uncancellable, and missed even by `forget()` (which can only cancel the
    // triggers `listReminders` knows about).
    if (!rearmedInPlace) await retireTrigger(scheduler, notificationId);
    throw e;
  }
  if (existing && !rearmedInPlace) await retireTrigger(scheduler, existing.notificationId);
  return id;
}

/** Cancel + delete a reminder (the Notifee trigger and the DB row). */
export async function cancelReminder(
  db: AppDatabase,
  reminder: Pick<Reminder, 'id' | 'notificationId'>,
  scheduler: ReminderScheduler = notifeeScheduler,
): Promise<void> {
  await scheduler.cancel(reminder.notificationId);
  await deleteReminder(db, reminder.id);
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
): Promise<string> {
  const notificationId = newNotificationId(reminder.messageGuid, scheduledFor);
  const messageDate = (await getMessageDateByGuid(db, reminder.messageGuid)) ?? undefined;
  const rearmedInPlace = reminder.notificationId === notificationId;
  // Schedule the new trigger FIRST so a failure leaves the old reminder intact
  // (no orphaned DB row pointing at a cancelled trigger).
  await scheduler.schedule({
    notificationId,
    chatGuid: reminder.chatGuid,
    messageGuid: reminder.messageGuid,
    title: reminder.senderName ?? 'Reminder',
    body: reminder.messagePreview ?? 'Reminder',
    scheduledFor,
    messageDate,
  });

  let moved: boolean;
  try {
    moved = await updateReminderTime(db, reminder.id, scheduledFor, notificationId);
  } catch (e) {
    if (!rearmedInPlace) await retireTrigger(scheduler, notificationId);
    throw e;
  }
  // `reminder` is a snapshot the screen captured BEFORE the time picker opened — a dialog that can
  // sit there for minutes — so by now the row may have been deleted from that same screen. The
  // update reports that (0 rows) instead of silently succeeding; without acting on it we would walk
  // away having armed an alarm for a reminder that no longer exists: it still fires, the Reminders
  // screen can neither show nor cancel it, and `forget()` can't either, because it only cancels the
  // triggers `listReminders` can find.
  if (!moved) {
    await retireTrigger(scheduler, notificationId);
    throw new Error('reminder no longer exists');
  }
  if (!rearmedInPlace) await retireTrigger(scheduler, reminder.notificationId);
  return notificationId;
}
