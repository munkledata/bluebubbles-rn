import { Chat, Message } from '@core/models';
import {
  deleteReminder,
  getReminderByMessageGuid,
  listReminders,
  updateReminderTime,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import {
  cancelReminder,
  rescheduleReminder,
  scheduleReminder,
  type ReminderScheduler,
} from '@/services/notifications/remindersService';
import { createTestDb } from '../support/testDb';

type ScheduleArgs = Parameters<ReminderScheduler['schedule']>[0];

function fakeScheduler() {
  const scheduled: string[] = [];
  const cancelled: string[] = [];
  const args: ScheduleArgs[] = [];
  const scheduler: ReminderScheduler = {
    schedule: async (a) => {
      scheduled.push(a.notificationId);
      args.push(a);
    },
    cancel: async (id) => {
      cancelled.push(id);
    },
  };
  return { scheduler, scheduled, cancelled, args };
}

/** Seed a chat with a single message ('m1') at a known date so getMessageDateByGuid resolves. */
async function seedMessage(db: AppDatabase, guid: string, dateCreated: number): Promise<void> {
  const handles = await upsertHandles(db, [{ address: 'alice@me.com' }]);
  const chatMap = await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', displayName: 'Alice', participants: [{ address: 'alice@me.com' }] })],
    handles,
  );
  await upsertMessages(
    db,
    [Message.parse({ guid, text: 'hi', dateCreated })],
    () => chatMap.get('c1')!,
    handles,
  );
}

const base = {
  chatGuid: 'c1',
  messageGuid: 'm1',
  chatTitle: 'Alice',
  messagePreview: 'see you at 5',
  senderName: 'Alice',
};

describe('scheduleReminder', () => {
  it('persists a reminder + schedules a Notifee trigger', async () => {
    const { db } = await createTestDb();
    const { scheduler, scheduled } = fakeScheduler();
    const id = await scheduleReminder(db, { ...base, scheduledFor: 5000, now: 1 }, scheduler);

    const r = await getReminderByMessageGuid(db, 'm1');
    expect(r?.id).toBe(id);
    expect(r?.scheduledFor).toBe(5000);
    expect(r?.notificationId).toBe('reminder-m1-5000');
    expect(scheduled).toEqual(['reminder-m1-5000']);
  });

  it('replaces an existing reminder for the same message (cancel old, one row)', async () => {
    const { db } = await createTestDb();
    const { scheduler, scheduled, cancelled } = fakeScheduler();
    await scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);
    await scheduleReminder(db, { ...base, scheduledFor: 9000 }, scheduler);

    const all = await listReminders(db);
    expect(all).toHaveLength(1);
    expect(all[0]?.scheduledFor).toBe(9000);
    expect(cancelled).toEqual(['reminder-m1-5000']); // old trigger cancelled
    expect(scheduled).toEqual(['reminder-m1-5000', 'reminder-m1-9000']);
  });

  it('MOVES the existing row (same id) instead of deleting and recreating it', async () => {
    const { db } = await createTestDb();
    const { scheduler } = fakeScheduler();
    const first = await scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);
    const second = await scheduleReminder(db, { ...base, scheduledFor: 9000 }, scheduler);
    // A stable id proves the replacement was one UPDATE — a delete-then-insert would mint a new
    // id and, worse, render "No reminders" on the reactive Reminders screen in between.
    expect(second).toBe(first);
  });

  it('leaves the existing reminder AND its trigger intact when scheduling the new one fails', async () => {
    const { db } = await createTestDb();
    const { scheduler } = fakeScheduler();
    await scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);

    const cancelled: string[] = [];
    const failing: ReminderScheduler = {
      schedule: async () => {
        throw new Error('notifee failed');
      },
      cancel: async (id) => {
        cancelled.push(id);
      },
    };
    await expect(scheduleReminder(db, { ...base, scheduledFor: 9000 }, failing)).rejects.toThrow(
      'notifee failed',
    );

    // The user asked for a new time and was told it failed — they must still have the OLD reminder,
    // not none at all.
    const after = await getReminderByMessageGuid(db, 'm1');
    expect(after?.scheduledFor).toBe(5000);
    expect(after?.notificationId).toBe('reminder-m1-5000');
    expect(cancelled).toEqual([]);
  });

  it('re-picking the SAME time does not cancel the trigger it just re-armed', async () => {
    const { db } = await createTestDb();
    const { scheduler, scheduled, cancelled } = fakeScheduler();
    await scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);
    await scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);

    expect(scheduled).toEqual(['reminder-m1-5000', 'reminder-m1-5000']); // re-armed in place
    expect(cancelled).toEqual([]); // cancelling it would leave the row with a dead alarm
    expect(await listReminders(db)).toHaveLength(1);
  });

  it('cancels the alarm it just armed when persisting the row fails', async () => {
    const t = await createTestDb();
    const cancelled: string[] = [];
    const scheduler: ReminderScheduler = {
      // Break the durable half at exactly the moment the alarm becomes real.
      schedule: async () => {
        t.raw.exec('DROP TABLE reminders');
      },
      cancel: async (id) => {
        cancelled.push(id);
      },
    };
    await expect(
      scheduleReminder(t.db, { ...base, scheduledFor: 5000 }, scheduler),
    ).rejects.toThrow();
    // Otherwise the trigger fires with no row behind it: unlistable, uncancellable from the
    // Reminders screen, and invisible to forget()'s cleanup.
    expect(cancelled).toEqual(['reminder-m1-5000']);
  });
});

describe('cancelReminder', () => {
  it('cancels the trigger and removes the row', async () => {
    const { db } = await createTestDb();
    const { scheduler, cancelled } = fakeScheduler();
    const id = await scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);
    await cancelReminder(db, { id, notificationId: 'reminder-m1-5000' }, scheduler);
    expect(await listReminders(db)).toHaveLength(0);
    expect(cancelled).toContain('reminder-m1-5000');
  });
});

describe('rescheduleReminder', () => {
  it('moves a reminder to a new time + new notification id', async () => {
    const { db } = await createTestDb();
    const { scheduler, scheduled, cancelled } = fakeScheduler();
    await scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);
    const r = (await getReminderByMessageGuid(db, 'm1'))!;
    const newId = await rescheduleReminder(db, r, 12000, scheduler);

    expect(newId).toBe('reminder-m1-12000');
    const updated = await getReminderByMessageGuid(db, 'm1');
    expect(updated?.scheduledFor).toBe(12000);
    expect(updated?.notificationId).toBe('reminder-m1-12000');
    expect(cancelled).toContain('reminder-m1-5000');
    expect(scheduled).toContain('reminder-m1-12000');
  });

  it('leaves the original reminder intact if scheduling the new trigger fails', async () => {
    const { db } = await createTestDb();
    const { scheduler } = fakeScheduler();
    await scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);
    const r = (await getReminderByMessageGuid(db, 'm1'))!;

    const cancelled: string[] = [];
    const failing: ReminderScheduler = {
      schedule: async () => {
        throw new Error('notifee failed');
      },
      cancel: async (id) => {
        cancelled.push(id);
      },
    };
    await expect(rescheduleReminder(db, r, 12000, failing)).rejects.toThrow('notifee failed');

    // The old reminder is untouched: no orphan, original trigger not cancelled.
    const after = await getReminderByMessageGuid(db, 'm1');
    expect(after?.scheduledFor).toBe(5000);
    expect(after?.notificationId).toBe('reminder-m1-5000');
    expect(cancelled).toEqual([]);
  });

  it('cancels the newly armed trigger and reports failure when the reminder is already gone', async () => {
    const { db } = await createTestDb();
    const { scheduler, cancelled } = fakeScheduler();
    await scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);
    // The Reminders screen hands `rescheduleReminder` a snapshot taken BEFORE the time picker
    // opened — that dialog can sit there for minutes, long enough for the row to be deleted.
    const stale = (await getReminderByMessageGuid(db, 'm1'))!;
    await deleteReminder(db, stale.id);

    await expect(rescheduleReminder(db, stale, 12000, scheduler)).rejects.toThrow();
    // The alarm we armed for a row that no longer exists must be taken back down: nothing could
    // ever cancel it afterwards (the screen can't list it; forget() only cancels what it can list).
    expect(cancelled).toContain('reminder-m1-12000');
    expect(await listReminders(db)).toHaveLength(0);
  });
});

describe('updateReminderTime (compare-and-set)', () => {
  it('reports true when it moved a row and false when the id no longer exists', async () => {
    const { db } = await createTestDb();
    const { scheduler } = fakeScheduler();
    const id = await scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);

    expect(await updateReminderTime(db, id, 12000, 'reminder-m1-12000')).toBe(true);
    expect((await getReminderByMessageGuid(db, 'm1'))?.scheduledFor).toBe(12000);

    await deleteReminder(db, id);
    expect(await updateReminderTime(db, id, 20000, 'reminder-m1-20000')).toBe(false);
    expect(await listReminders(db)).toHaveLength(0);
  });
});

describe('reminder message-date plumbing (focusDate deep-link)', () => {
  it('passes the reminded message’s dateCreated to the scheduler when the message is known', async () => {
    const { db } = await createTestDb();
    await seedMessage(db, 'm1', 1700000000000);
    const { scheduler, args } = fakeScheduler();
    await scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);
    expect(args[0]?.messageDate).toBe(1700000000000);
  });

  it('omits messageDate (undefined) when the message is not in the DB', async () => {
    const { db } = await createTestDb();
    const { scheduler, args } = fakeScheduler();
    await scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);
    expect(args[0]?.messageDate).toBeUndefined();
  });

  it('carries messageDate through a reschedule too', async () => {
    const { db } = await createTestDb();
    await seedMessage(db, 'm1', 1700000000000);
    const { scheduler, args } = fakeScheduler();
    await scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);
    const r = (await getReminderByMessageGuid(db, 'm1'))!;
    await rescheduleReminder(db, r, 12000, scheduler);
    // args[0] = initial schedule, args[1] = reschedule
    expect(args[1]?.messageDate).toBe(1700000000000);
  });
});

describe('listReminders', () => {
  it('returns reminders soonest-first', async () => {
    const { db } = await createTestDb();
    const { scheduler } = fakeScheduler();
    await scheduleReminder(db, { ...base, messageGuid: 'm1', scheduledFor: 9000 }, scheduler);
    await scheduleReminder(db, { ...base, messageGuid: 'm2', scheduledFor: 3000 }, scheduler);
    const all = await listReminders(db);
    expect(all.map((r) => r.scheduledFor)).toEqual([3000, 9000]);
  });
});
