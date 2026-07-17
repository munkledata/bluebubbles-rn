import { Chat, Message } from '@core/models';
import {
  getReminderByMessageGuid,
  listReminders,
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
