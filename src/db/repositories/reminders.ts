import { eq, sql } from 'drizzle-orm';
import type { Reminder } from '@core/models';
import { reminders } from '../schema';
import type { AppDatabase } from '../types';

// ---- Reminders -------------------------------------------------------------

export async function createReminder(
  db: AppDatabase,
  r: Omit<Reminder, 'id' | 'createdAt'> & { createdAt?: number | null },
): Promise<number> {
  const rows = await db
    .insert(reminders)
    .values({
      messageGuid: r.messageGuid,
      chatGuid: r.chatGuid,
      messagePreview: r.messagePreview,
      senderName: r.senderName,
      scheduledFor: r.scheduledFor,
      notificationId: r.notificationId,
      createdAt: r.createdAt ?? null,
    })
    .returning({ id: reminders.id });
  return rows[0]!.id;
}

const REMINDER_COLS = sql`id, message_guid AS messageGuid, chat_guid AS chatGuid,
  message_preview AS messagePreview, sender_name AS senderName, scheduled_for AS scheduledFor,
  notification_id AS notificationId, created_at AS createdAt`;

/** All reminders, soonest first. */
export async function listReminders(db: AppDatabase): Promise<Reminder[]> {
  return db.all<Reminder>(sql`SELECT ${REMINDER_COLS} FROM reminders ORDER BY scheduled_for ASC`);
}

export async function getReminderByMessageGuid(
  db: AppDatabase,
  messageGuid: string,
): Promise<Reminder | null> {
  const rows = await db.all<Reminder>(
    sql`SELECT ${REMINDER_COLS} FROM reminders WHERE message_guid = ${messageGuid} LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function deleteReminder(db: AppDatabase, id: number): Promise<void> {
  await db.delete(reminders).where(eq(reminders.id, id));
}

export async function deleteReminderByNotificationId(
  db: AppDatabase,
  notificationId: string,
): Promise<void> {
  await db.delete(reminders).where(eq(reminders.notificationId, notificationId));
}

/**
 * Point a reminder at a new time + trigger id. Returns whether a row actually matched.
 *
 * The boolean is load-bearing, not a convenience: an OS trigger notification is system state that
 * outlives its row, and the caller arms the new trigger BEFORE this write. A silent zero-row update
 * (the reminder was deleted while the time picker sat open — that dialog can be up for minutes)
 * would leave a trigger armed with nothing behind it: it still fires, the Reminders screen can't
 * show or cancel it, and even Disconnect misses it because `forget()` only cancels the triggers it
 * can find via `listReminders`. Reported here so the caller can cancel the half that succeeded.
 */
export async function updateReminderTime(
  db: AppDatabase,
  id: number,
  scheduledFor: number,
  notificationId: string,
): Promise<boolean> {
  const rows = await db
    .update(reminders)
    .set({ scheduledFor, notificationId })
    .where(eq(reminders.id, id))
    .returning({ id: reminders.id });
  return rows.length > 0;
}
