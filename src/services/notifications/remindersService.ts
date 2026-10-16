import {
  createReminderWithinTransaction,
  deleteReminderWithinTransaction,
  getMessageDateByGuid,
  getReminderByMessageGuid,
  updateReminderTimeWithinTransaction,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import type { Reminder } from '@core/models';
import { logger } from '@core/secure';
import { parseRcsChatGuid, parseRcsMessageGuid } from '@core/rcs';
import { sessionAccessors } from '@state/sessionStore';
import { ensureDatabase } from '../databaseControl';
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

function captureReminderIdentityGuard(
  target: Pick<ScheduleReminderArgs, 'chatGuid' | 'messageGuid'>,
): () => boolean {
  const rcsChat = target.chatGuid.startsWith('RCS;-;');
  const rcsMessage = target.messageGuid.startsWith('rcs-');
  if (!rcsChat && !rcsMessage) return () => true;
  const expectedEpoch = sessionAccessors.rcsProviderEpoch();
  if (
    !rcsChat ||
    !rcsMessage ||
    expectedEpoch == null ||
    parseRcsChatGuid(target.chatGuid)?.providerEpoch !== expectedEpoch ||
    parseRcsMessageGuid(target.messageGuid)?.providerEpoch !== expectedEpoch
  ) {
    throw new Error(
      'This RCS message is read-only because its Google pairing is no longer current.',
    );
  }
  return () =>
    sessionAccessors.rcsProviderEpoch() === expectedEpoch &&
    sessionAccessors.acceptsRcsChat(target.chatGuid) &&
    sessionAccessors.acceptsRcsMessage(target.messageGuid);
}

/** Acquire the composition-root database while the originating account remains admitted. */
async function acquireReminderDatabase(lease: RealtimeDeliveryLease): Promise<AppDatabase> {
  const opened: { db?: AppDatabase } = {};
  const status = await runTrackedRealtimeWork(lease, async () => {
    assertReminderLease(lease);
    const db = await ensureDatabase();
    assertReminderLease(lease);
    opened.db = db;
  });
  if (status === 'paused' || !opened.db || !lease.isCurrent()) {
    throw new ReminderSessionChangedError();
  }
  return opened.db;
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
  scheduledFor: number;
  now?: number;
}

/** UI-facing reminder creation without exposing the database or native scheduler. */
export async function scheduleMessageReminder(
  args: ScheduleReminderArgs,
  accountLease: RealtimeDeliveryLease,
): Promise<number> {
  const identityIsCurrent = captureReminderIdentityGuard(args);
  if (!identityIsCurrent()) throw new ReminderSessionChangedError();
  const db = await acquireReminderDatabase(accountLease);
  return scheduleReminder(db, args, notifeeScheduler, accountLease);
}

/**
 * UI-facing reminder cancellation without exposing the database or native scheduler. Cancel and
 * reschedule touch only the local row and the local alarm, so unlike creation they need the
 * account but not a current RCS pairing: a re-pair or a down bridge must not strand an alarm.
 */
export async function cancelMessageReminder(
  reminder: Pick<Reminder, 'id' | 'notificationId' | 'chatGuid' | 'messageGuid'>,
  accountLease: RealtimeDeliveryLease,
): Promise<void> {
  const db = await acquireReminderDatabase(accountLease);
  await cancelReminder(db, reminder, notifeeScheduler, accountLease);
}

/** UI-facing reminder reschedule without exposing the database or native scheduler. */
export async function rescheduleMessageReminder(
  reminder: Reminder,
  scheduledFor: number,
  accountLease: RealtimeDeliveryLease,
): Promise<string> {
  const db = await acquireReminderDatabase(accountLease);
  return rescheduleReminder(db, reminder, scheduledFor, notifeeScheduler, accountLease);
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
  const identityIsCurrent = captureReminderIdentityGuard(args);
  const assertOperationCurrent = (): void => {
    assertReminderLease(accountLease);
    if (!identityIsCurrent()) throw new ReminderSessionChangedError();
  };
  let candidateNotificationId: string | null = null;
  return runReminderAccountOperation(
    accountLease,
    async () => {
      assertOperationCurrent();
      const existing = await getReminderByMessageGuid(db, args.messageGuid);
      assertOperationCurrent();
      let notificationId: string;
      if (
        existing?.scheduledFor === args.scheduledFor &&
        isSafeReminderNotificationId(existing.notificationId)
      ) {
        notificationId = existing.notificationId;
      } else {
        notificationId = await newReminderNotificationId(db, args.messageGuid, args.scheduledFor);
        assertOperationCurrent();
      }
      candidateNotificationId = notificationId;
      // Re-picking the same minute yields the same id, so `schedule` re-arms the SAME trigger in place.
      // Retiring "the old" one would then cancel the one we just armed — and the failure path must not
      // cancel it either, since the pre-existing row still depends on it.
      const rearmedInPlace = existing != null && existing.notificationId === notificationId;
      // Look up the reminded message's date so the notification tap can center the chat on it
      // (?focusDate deep-link). null when the message is gone — the tap still opens the chat.
      const messageDate = (await getMessageDateByGuid(db, args.messageGuid)) ?? undefined;
      assertOperationCurrent();
      try {
        await scheduler.schedule({
          notificationId,
          chatGuid: args.chatGuid,
          messageGuid: args.messageGuid,
          scheduledFor: args.scheduledFor,
          messageDate,
        });
        assertOperationCurrent();
      } catch (error) {
        if (!rearmedInPlace) await retireUncertainTrigger(scheduler, notificationId, error);
        throw error;
      }

      let id: number | null = null;
      try {
        // MOVE the existing row rather than delete-and-recreate it: the Reminders list is a reactive
        // query and every write wakes it, so a delete-then-insert genuinely renders "No reminders" in
        // between. Match the notification id we read before crossing the native bridge. If another
        // operation changed or deleted that row while scheduling, this older operation must retire its
        // candidate instead of overwriting the newer reminder or creating a duplicate row.
        // The durable row stores no frozen preview text, and native reminder presentation is
        // deliberately generic; the live message projection remains the content authority.
        if (existing) {
          const moved = await withDbTransaction(
            db,
            (context) =>
              updateReminderTimeWithinTransaction(
                context,
                existing.id,
                args.scheduledFor,
                notificationId,
                existing.notificationId,
              ),
            () => accountLease.isCurrent() && identityIsCurrent(),
          );
          if (!moved) throw new Error('reminder no longer matches');
          id = existing.id;
        }
        assertOperationCurrent();
        if (id == null) {
          id = await withDbTransaction(
            db,
            (context) =>
              createReminderWithinTransaction(context, {
                messageGuid: args.messageGuid,
                chatGuid: args.chatGuid,
                scheduledFor: args.scheduledFor,
                notificationId,
                createdAt: args.now ?? null,
              }),
            () => accountLease.isCurrent() && identityIsCurrent(),
          );
          assertOperationCurrent();
        }
      } catch (e) {
        // The durable half failed after the alarm was armed. Un-arm it, or it fires with no row behind
        // it — unlistable and uncancellable during the live session. Disconnect's broad native
        // cancellation is a backstop, but normal reminder management still needs a durable row.
        if (!rearmedInPlace) await retireUncertainTrigger(scheduler, notificationId, e);
        throw e;
      }
      if (existing && !rearmedInPlace) await retireTrigger(scheduler, existing.notificationId);
      assertOperationCurrent();
      return id;
    },
    scheduler,
    () => candidateNotificationId,
  );
}

/** Cancel + delete a reminder (the Notifee trigger and the DB row). */
export async function cancelReminder(
  db: AppDatabase,
  reminder: Pick<Reminder, 'id' | 'notificationId' | 'chatGuid' | 'messageGuid'>,
  scheduler: ReminderScheduler = notifeeScheduler,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  const assertOperationCurrent = (): void => assertReminderLease(accountLease);
  await runReminderAccountOperation(
    accountLease,
    async () => {
      assertOperationCurrent();
      const stored = await getReminderByMessageGuid(db, reminder.messageGuid);
      assertOperationCurrent();
      if (
        !stored ||
        stored.id !== reminder.id ||
        stored.notificationId !== reminder.notificationId ||
        stored.chatGuid !== reminder.chatGuid
      ) {
        throw new Error('reminder no longer matches');
      }
      const messageDate = (await getMessageDateByGuid(db, reminder.messageGuid)) ?? undefined;
      assertOperationCurrent();
      let nativeCancelled = false;
      let rowDeleted = false;
      try {
        await scheduler.cancel(reminder.notificationId);
        nativeCancelled = true;
        assertOperationCurrent();
        rowDeleted = await withDbTransaction(
          db,
          (context) =>
            deleteReminderWithinTransaction(context, reminder.id, reminder.notificationId),
          () => accountLease.isCurrent(),
        );
        assertOperationCurrent();
        if (!rowDeleted) throw new Error('reminder no longer matches');
      } catch (error) {
        // Cancellation crosses the native bridge before the durable row can be removed. If the
        // account retires or the guarded delete rolls back, restore the trigger that the still-
        // present row owns so the operation converges back to its original state.
        if (nativeCancelled && !rowDeleted) {
          await scheduler.schedule({
            notificationId: reminder.notificationId,
            chatGuid: reminder.chatGuid,
            messageGuid: reminder.messageGuid,
            scheduledFor: stored.scheduledFor,
            messageDate,
          });
        }
        throw error;
      }
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
  const assertOperationCurrent = (): void => assertReminderLease(accountLease);
  let candidateNotificationId: string | null = null;
  return runReminderAccountOperation(
    accountLease,
    async () => {
      assertOperationCurrent();
      const notificationId = await newReminderNotificationId(
        db,
        reminder.messageGuid,
        scheduledFor,
      );
      assertOperationCurrent();
      candidateNotificationId = notificationId;
      const messageDate = (await getMessageDateByGuid(db, reminder.messageGuid)) ?? undefined;
      assertOperationCurrent();
      const rearmedInPlace = reminder.notificationId === notificationId;
      // Schedule the new trigger FIRST so a failure leaves the old reminder intact
      // (no orphaned DB row pointing at a cancelled trigger).
      try {
        await scheduler.schedule({
          notificationId,
          chatGuid: reminder.chatGuid,
          messageGuid: reminder.messageGuid,
          scheduledFor,
          messageDate,
        });
        assertOperationCurrent();
      } catch (error) {
        if (!rearmedInPlace) await retireUncertainTrigger(scheduler, notificationId, error);
        throw error;
      }

      let moved: boolean;
      try {
        moved = await withDbTransaction(
          db,
          (context) =>
            updateReminderTimeWithinTransaction(
              context,
              reminder.id,
              scheduledFor,
              notificationId,
              reminder.notificationId,
            ),
          () => accountLease.isCurrent(),
        );
        assertOperationCurrent();
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
      assertOperationCurrent();
      return notificationId;
    },
    scheduler,
    () => candidateNotificationId,
  );
}
