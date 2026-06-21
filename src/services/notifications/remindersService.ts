import {
  createReminder,
  deleteReminder,
  getReminderByMessageGuid,
  updateReminderTime,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import type { Reminder } from '@core/models';
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
 * Schedule (or replace) a reminder for a message. Cancels any prior reminder for
 * the same message first, schedules a Notifee trigger, then persists the row.
 * Returns the new reminder id.
 */
export async function scheduleReminder(
  db: AppDatabase,
  args: ScheduleReminderArgs,
  scheduler: ReminderScheduler = notifeeScheduler,
): Promise<number> {
  const existing = await getReminderByMessageGuid(db, args.messageGuid);
  if (existing) {
    await scheduler.cancel(existing.notificationId);
    await deleteReminder(db, existing.id);
  }
  const notificationId = newNotificationId(args.messageGuid, args.scheduledFor);
  await scheduler.schedule({
    notificationId,
    chatGuid: args.chatGuid,
    messageGuid: args.messageGuid,
    title: args.chatTitle,
    body: args.messagePreview ?? 'Reminder',
    scheduledFor: args.scheduledFor,
  });
  return createReminder(db, {
    messageGuid: args.messageGuid,
    chatGuid: args.chatGuid,
    messagePreview: args.messagePreview,
    senderName: args.senderName,
    scheduledFor: args.scheduledFor,
    notificationId,
    createdAt: args.now ?? null,
  });
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

/** Move a reminder to a new time: cancel the old trigger, schedule a new one. */
export async function rescheduleReminder(
  db: AppDatabase,
  reminder: Reminder,
  scheduledFor: number,
  scheduler: ReminderScheduler = notifeeScheduler,
): Promise<string> {
  const notificationId = newNotificationId(reminder.messageGuid, scheduledFor);
  // Schedule the new trigger FIRST so a failure leaves the old reminder intact
  // (no orphaned DB row pointing at a cancelled trigger).
  await scheduler.schedule({
    notificationId,
    chatGuid: reminder.chatGuid,
    messageGuid: reminder.messageGuid,
    title: reminder.senderName ?? 'Reminder',
    body: reminder.messagePreview ?? 'Reminder',
    scheduledFor,
  });
  await scheduler.cancel(reminder.notificationId);
  await updateReminderTime(db, reminder.id, scheduledFor, notificationId);
  return notificationId;
}
