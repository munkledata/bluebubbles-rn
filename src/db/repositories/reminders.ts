import { and, eq, sql } from 'drizzle-orm';
import type { Reminder } from '@core/models';
import { reminders } from '../schema';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbCommitGuard,
  type DbTransactionContext,
} from '../transaction';
import type { AppDatabase } from '../types';
import { messageHasVisibleContentSql } from './chatVisibility';

// ---- Reminders -------------------------------------------------------------

export type CreateReminderArgs = Omit<Reminder, 'id' | 'createdAt'> & {
  createdAt?: number | null;
};

/** Transaction-only body for one new durable reminder row. */
export function createReminderWithinTransaction(
  context: DbTransactionContext,
  r: CreateReminderArgs,
): Promise<number> {
  return runInTransactionContext(context, async (db) => {
    const rows = await db
      .insert(reminders)
      .values({
        messageGuid: r.messageGuid,
        chatGuid: r.chatGuid,
        // A reminder can fire after an unsend/retraction while the app is dead. Store no frozen
        // plaintext copy that could outlive the authoritative encrypted message projection.
        messagePreview: null,
        senderName: null,
        scheduledFor: r.scheduledFor,
        notificationId: r.notificationId,
        createdAt: r.createdAt ?? null,
      })
      .returning({ id: reminders.id });
    return rows[0]!.id;
  });
}

const REMINDER_COLS = sql`id, message_guid AS messageGuid, chat_guid AS chatGuid,
  message_preview AS messagePreview, sender_name AS senderName, scheduled_for AS scheduledFor,
  notification_id AS notificationId, created_at AS createdAt`;

/**
 * All reminders, soonest first, each with its message's LIVE text and sender. Rows store no copy, so
 * an unsent message shows no text and a locally deleted or missing one shows neither.
 */
export async function listReminders(db: AppDatabase): Promise<Reminder[]> {
  return db.all<Reminder>(sql`
    SELECT r.id, r.message_guid AS messageGuid, r.chat_guid AS chatGuid,
           CASE WHEN ${messageHasVisibleContentSql('m')} THEN NULLIF(TRIM(m.text), '') END
             AS messagePreview,
           CASE WHEN m.is_from_me = 0 THEN COALESCE(h.display_name, h.address) END AS senderName,
           r.scheduled_for AS scheduledFor, r.notification_id AS notificationId,
           r.created_at AS createdAt
      FROM reminders r
      LEFT JOIN messages m
        ON m.guid = r.message_guid
       AND m.date_deleted IS NULL
       AND m.chat_id = (SELECT c.id FROM chats c WHERE c.guid = r.chat_guid LIMIT 1)
      LEFT JOIN handles h ON h.id = m.handle_id
     ORDER BY r.scheduled_for ASC`);
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

export function deleteReminderWithinTransaction(
  context: DbTransactionContext,
  id: number,
  expectedNotificationId?: string,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    const deleted = await db
      .delete(reminders)
      .where(
        expectedNotificationId == null
          ? eq(reminders.id, id)
          : and(eq(reminders.id, id), eq(reminders.notificationId, expectedNotificationId)),
      )
      .returning({ id: reminders.id });
    return deleted.length > 0;
  });
}

export function deleteReminderByNotificationIdWithinTransaction(
  context: DbTransactionContext,
  notificationId: string,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    await db.delete(reminders).where(eq(reminders.notificationId, notificationId));
  });
}

export async function deleteReminderByNotificationId(
  db: AppDatabase,
  notificationId: string,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  await withDbTransaction(
    db,
    (context) => deleteReminderByNotificationIdWithinTransaction(context, notificationId),
    commitGuard,
  );
}

/**
 * Point a reminder at a new time + trigger id. Returns whether a row actually matched.
 *
 * The boolean is load-bearing, not a convenience: an OS trigger notification is system state that
 * outlives its row, and the caller arms the new trigger BEFORE this write. A silent zero-row update
 * (the reminder was deleted while the time picker sat open — that dialog can be up for minutes)
 * would leave a trigger armed with nothing behind it: it still fires, and the Reminders screen
 * can't show or cancel it. Disconnect broadly clears native notifications as a final backstop;
 * this result lets the live caller cancel the half that succeeded immediately.
 */
export function updateReminderTimeWithinTransaction(
  context: DbTransactionContext,
  id: number,
  scheduledFor: number,
  notificationId: string,
  expectedNotificationId?: string,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    const rows = await db
      .update(reminders)
      .set({ scheduledFor, notificationId })
      .where(
        expectedNotificationId == null
          ? eq(reminders.id, id)
          : and(eq(reminders.id, id), eq(reminders.notificationId, expectedNotificationId)),
      )
      .returning({ id: reminders.id });
    return rows.length > 0;
  });
}
