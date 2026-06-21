import { getReminderByMessageGuid, listReminders } from '@db/repositories';
import {
  cancelReminder,
  rescheduleReminder,
  scheduleReminder,
  type ReminderScheduler,
} from '@/services/notifications/remindersService';
import { createTestDb } from '../support/testDb';

function fakeScheduler() {
  const scheduled: string[] = [];
  const cancelled: string[] = [];
  const scheduler: ReminderScheduler = {
    schedule: async (a) => {
      scheduled.push(a.notificationId);
    },
    cancel: async (id) => {
      cancelled.push(id);
    },
  };
  return { scheduler, scheduled, cancelled };
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
