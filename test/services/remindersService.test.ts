import { Chat, Message } from '@core/models';
import {
  createReminder,
  deleteReminder,
  deleteReminderByNotificationId,
  deleteReminderByNotificationIdWithinTransaction,
  getReminderByMessageGuid,
  listReminders,
  updateReminderTime,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  cancelReminder,
  rescheduleReminder,
  scheduleReminder,
  type ReminderScheduler,
} from '@/services/notifications/remindersService';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { createTestDb } from '../support/testDb';

jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(() => '7f000000-0000-4000-8000-000000000001'),
}));

const reminderId = (scheduledFor: number): string =>
  `gator-reminder-random-7f000000-0000-4000-8000-000000000001-${scheduledFor}`;

type ScheduleArgs = Parameters<ReminderScheduler['schedule']>[0];

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('deferred reminder did not reach its native scheduling seam');
}

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

async function holdWriter(db: AppDatabase): Promise<{
  release(): void;
  outcome: Promise<void>;
}> {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const outcome = withDbTransaction(db, async () => {
    markStarted();
    await held;
  });
  await started;
  return { release, outcome };
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

beforeEach(() => resumeRealtimeDeliveries());

afterEach(async () => {
  await pauseRealtimeDeliveries();
  resumeRealtimeDeliveries();
});

describe('scheduleReminder', () => {
  it('persists a reminder + schedules a Notifee trigger', async () => {
    const { db } = await createTestDb();
    const { scheduler, scheduled } = fakeScheduler();
    const id = await scheduleReminder(db, { ...base, scheduledFor: 5000, now: 1 }, scheduler);

    const r = await getReminderByMessageGuid(db, 'm1');
    expect(r?.id).toBe(id);
    expect(r?.scheduledFor).toBe(5000);
    expect(r?.notificationId).toBe(reminderId(5000));
    expect(scheduled).toEqual([reminderId(5000)]);
  });

  it('replaces an existing reminder for the same message (cancel old, one row)', async () => {
    const { db } = await createTestDb();
    const { scheduler, scheduled, cancelled } = fakeScheduler();
    await scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);
    await scheduleReminder(db, { ...base, scheduledFor: 9000 }, scheduler);

    const all = await listReminders(db);
    expect(all).toHaveLength(1);
    expect(all[0]?.scheduledFor).toBe(9000);
    expect(cancelled).toEqual([reminderId(5000)]); // old trigger cancelled
    expect(scheduled).toEqual([reminderId(5000), reminderId(9000)]);
  });

  it('does not let a slow older schedule overwrite a newer schedule', async () => {
    const { db } = await createTestDb();
    const initial = fakeScheduler();
    await scheduleReminder(db, { ...base, scheduledFor: 5000 }, initial.scheduler);

    const slowGate = deferred<void>();
    let slowStarted = false;
    const slowCancelled: string[] = [];
    const slowScheduler: ReminderScheduler = {
      schedule: async () => {
        slowStarted = true;
        await slowGate.promise;
      },
      cancel: async (notificationId) => {
        slowCancelled.push(notificationId);
      },
    };

    const older = scheduleReminder(db, { ...base, scheduledFor: 9000 }, slowScheduler);
    await waitUntil(() => slowStarted);
    await scheduleReminder(db, { ...base, scheduledFor: 12000 }, fakeScheduler().scheduler);
    slowGate.resolve(undefined);

    await expect(older).rejects.toThrow('reminder no longer matches');
    expect(await listReminders(db)).toEqual([
      expect.objectContaining({
        scheduledFor: 12000,
        notificationId: reminderId(12000),
      }),
    ]);
    expect(slowCancelled).toEqual([reminderId(9000)]);
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
    expect(after?.notificationId).toBe(reminderId(5000));
    expect(cancelled).toEqual([reminderId(9000)]);
  });

  it('strictly retires an uncertain new trigger when the native schedule rejects', async () => {
    const { db } = await createTestDb();
    const cancelled: string[] = [];
    const scheduler: ReminderScheduler = {
      schedule: async () => {
        throw new Error('uncertain native schedule');
      },
      cancel: async (notificationId) => {
        cancelled.push(notificationId);
      },
    };

    await expect(scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler)).rejects.toThrow(
      'uncertain native schedule',
    );
    expect(cancelled).toEqual([reminderId(5000)]);
    expect(await listReminders(db)).toEqual([]);
  });

  it('does not cancel the existing trigger when an in-place rearm rejects', async () => {
    const { db } = await createTestDb();
    const initial = fakeScheduler();
    await scheduleReminder(db, { ...base, scheduledFor: 5000 }, initial.scheduler);
    const cancelled: string[] = [];
    const scheduler: ReminderScheduler = {
      schedule: async () => {
        throw new Error('in-place rearm failed');
      },
      cancel: async (notificationId) => {
        cancelled.push(notificationId);
      },
    };

    await expect(scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler)).rejects.toThrow(
      'in-place rearm failed',
    );
    expect(cancelled).toEqual([]);
    expect(await getReminderByMessageGuid(db, 'm1')).toMatchObject({
      scheduledFor: 5000,
      notificationId: reminderId(5000),
    });
  });

  it('surfaces a failed cleanup instead of claiming an uncertain trigger was contained', async () => {
    const { db } = await createTestDb();
    const scheduler: ReminderScheduler = {
      schedule: async () => {
        throw new Error('uncertain native schedule');
      },
      cancel: async () => {
        throw new Error('native cleanup failed');
      },
    };

    await expect(scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler)).rejects.toThrow(
      'could not retire an uncertain reminder trigger',
    );
  });

  it('re-picking the SAME time does not cancel the trigger it just re-armed', async () => {
    const { db } = await createTestDb();
    const { scheduler, scheduled, cancelled } = fakeScheduler();
    await scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);
    await scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);

    expect(scheduled).toEqual([reminderId(5000), reminderId(5000)]); // re-armed in place
    expect(cancelled).toEqual([]); // cancelling it would leave the row with a dead alarm
    expect(await listReminders(db)).toHaveLength(1);
  });

  it('cancels the alarm it just armed when persisting the row fails', async () => {
    const t = await createTestDb();
    const cancelled: string[] = [];
    // Fail the exact durable-write seam under test. Dropping the table from scheduler.schedule()
    // was order-dependent under the full suite and did not reliably make the later insert throw.
    // A local insert spy is deterministic and leaves schema state out of a test whose contract is
    // schedule → persist fails → cancel the new alarm.
    const insert = jest.spyOn(t.db, 'insert').mockImplementation(() => {
      throw new Error('reminder persistence failed');
    });
    const scheduler: ReminderScheduler = {
      schedule: async () => undefined,
      cancel: async (id) => {
        cancelled.push(id);
      },
    };
    await expect(
      scheduleReminder(t.db, { ...base, scheduledFor: 5000 }, scheduler),
    ).rejects.toThrow('reminder persistence failed');
    expect(insert).toHaveBeenCalledTimes(1);
    // Otherwise the trigger fires with no row behind it: unlistable, uncancellable from the
    // Reminders screen, and invisible to forget()'s cleanup.
    expect(cancelled).toEqual([reminderId(5000)]);
  });

  it('cancels a native trigger that finishes arming after A was replaced by B', async () => {
    const { db } = await createTestDb();
    const native = deferred<void>();
    const cancelled: string[] = [];
    let scheduleStarted = false;
    const scheduler: ReminderScheduler = {
      schedule: async () => {
        scheduleStarted = true;
        await native.promise;
      },
      cancel: async (notificationId) => {
        cancelled.push(notificationId);
      },
    };

    const pending = scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);
    await waitUntil(() => scheduleStarted);
    const rejected = expect(pending).rejects.toThrow('account session changed');
    const drain = pauseRealtimeDeliveries();
    resumeRealtimeDeliveries(); // old generation stays revoked even if B opens admission
    native.resolve(undefined);

    await rejected;
    await drain;
    expect(cancelled).toContain(reminderId(5000));
    expect(await listReminders(db)).toEqual([]);
  });

  it('rejects a reminder insert that was still waiting for the DB when A was retired', async () => {
    const { db } = await createTestDb();
    const writer = await holdWriter(db);
    const { scheduler, scheduled, cancelled } = fakeScheduler();
    const pending = scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);
    await waitUntil(() => scheduled.length === 1);

    const rejected = expect(pending).rejects.toThrow('account session changed');
    const drain = pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    writer.release();

    await writer.outcome;
    await rejected;
    await drain;
    expect(await listReminders(db)).toEqual([]);
    expect(cancelled).toContain(reminderId(5000));
  });
});

describe('cancelReminder', () => {
  it('cancels the trigger and removes the row', async () => {
    const { db } = await createTestDb();
    const { scheduler, cancelled } = fakeScheduler();
    const id = await scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);
    await cancelReminder(db, { id, notificationId: reminderId(5000) }, scheduler);
    expect(await listReminders(db)).toHaveLength(0);
    expect(cancelled).toContain(reminderId(5000));
  });

  it('does not delete the durable row when A’s native cancel completes after B', async () => {
    const { db } = await createTestDb();
    const initial = fakeScheduler();
    const id = await scheduleReminder(db, { ...base, scheduledFor: 5000 }, initial.scheduler);
    const native = deferred<void>();
    let cancelStarted = false;
    const scheduler: ReminderScheduler = {
      schedule: async () => undefined,
      cancel: async () => {
        cancelStarted = true;
        await native.promise;
      },
    };

    const pending = cancelReminder(db, { id, notificationId: reminderId(5000) }, scheduler);
    await waitUntil(() => cancelStarted);
    const rejected = expect(pending).rejects.toThrow('account session changed');
    const drain = pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    native.resolve(undefined);

    await rejected;
    await drain;
    expect(await getReminderByMessageGuid(db, 'm1')).not.toBeNull();
  });

  it('rejects a reminder delete that was still waiting for the DB when A was retired', async () => {
    const { db } = await createTestDb();
    const initial = fakeScheduler();
    const id = await scheduleReminder(db, { ...base, scheduledFor: 5000 }, initial.scheduler);
    const writer = await holdWriter(db);
    const { scheduler, cancelled } = fakeScheduler();
    const pending = cancelReminder(db, { id, notificationId: reminderId(5000) }, scheduler);
    await waitUntil(() => cancelled.length === 1);

    const rejected = expect(pending).rejects.toThrow('account session changed');
    const drain = pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    writer.release();

    await writer.outcome;
    await rejected;
    await drain;
    expect(await getReminderByMessageGuid(db, 'm1')).not.toBeNull();
  });

  it('does not let a stale snapshot delete a newer reschedule', async () => {
    const { db } = await createTestDb();
    const { scheduler, cancelled } = fakeScheduler();
    await scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);
    const stale = (await getReminderByMessageGuid(db, 'm1'))!;
    await rescheduleReminder(db, stale, 9000, scheduler);

    await expect(cancelReminder(db, stale, scheduler)).rejects.toThrow(
      'reminder no longer matches',
    );
    expect(await getReminderByMessageGuid(db, 'm1')).toMatchObject({
      scheduledFor: 9000,
      notificationId: reminderId(9000),
    });
    expect(cancelled).not.toContain(reminderId(9000));
  });
});

describe('rescheduleReminder', () => {
  it('moves a reminder to a new time + new notification id', async () => {
    const { db } = await createTestDb();
    const { scheduler, scheduled, cancelled } = fakeScheduler();
    await scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);
    const r = (await getReminderByMessageGuid(db, 'm1'))!;
    const newId = await rescheduleReminder(db, r, 12000, scheduler);

    expect(newId).toBe(reminderId(12000));
    const updated = await getReminderByMessageGuid(db, 'm1');
    expect(updated?.scheduledFor).toBe(12000);
    expect(updated?.notificationId).toBe(reminderId(12000));
    expect(cancelled).toContain(reminderId(5000));
    expect(scheduled).toContain(reminderId(12000));
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
    expect(after?.notificationId).toBe(reminderId(5000));
    expect(cancelled).toEqual([reminderId(12000)]);
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
    // cancel it afterwards from the live screen (Disconnect's broad native cleanup is only a final
    // backstop).
    expect(cancelled).toContain(reminderId(12000));
    expect(await listReminders(db)).toHaveLength(0);
  });

  it('cancels a reschedule trigger that finishes arming after A was replaced by B', async () => {
    const { db } = await createTestDb();
    const initial = fakeScheduler();
    await scheduleReminder(db, { ...base, scheduledFor: 5000 }, initial.scheduler);
    const reminder = (await getReminderByMessageGuid(db, 'm1'))!;
    const native = deferred<void>();
    const cancelled: string[] = [];
    let scheduleStarted = false;
    const scheduler: ReminderScheduler = {
      schedule: async () => {
        scheduleStarted = true;
        await native.promise;
      },
      cancel: async (notificationId) => {
        cancelled.push(notificationId);
      },
    };

    const pending = rescheduleReminder(db, reminder, 12000, scheduler);
    await waitUntil(() => scheduleStarted);
    const rejected = expect(pending).rejects.toThrow('account session changed');
    const drain = pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    native.resolve(undefined);

    await rejected;
    await drain;
    expect(cancelled).toContain(reminderId(12000));
    expect(await getReminderByMessageGuid(db, 'm1')).toMatchObject({
      scheduledFor: 5000,
      notificationId: reminderId(5000),
    });
  });

  it('rejects a reminder move that was still waiting for the DB when A was retired', async () => {
    const { db } = await createTestDb();
    const initial = fakeScheduler();
    await scheduleReminder(db, { ...base, scheduledFor: 5000 }, initial.scheduler);
    const reminder = (await getReminderByMessageGuid(db, 'm1'))!;
    const writer = await holdWriter(db);
    const { scheduler, scheduled, cancelled } = fakeScheduler();
    const pending = rescheduleReminder(db, reminder, 12000, scheduler);
    await waitUntil(() => scheduled.length === 1);

    const rejected = expect(pending).rejects.toThrow('account session changed');
    const drain = pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    writer.release();

    await writer.outcome;
    await rejected;
    await drain;
    expect(await getReminderByMessageGuid(db, 'm1')).toMatchObject({
      scheduledFor: 5000,
      notificationId: reminderId(5000),
    });
    expect(cancelled).toContain(reminderId(12000));
  });

  it('does not let a stale snapshot overwrite a newer reschedule', async () => {
    const { db } = await createTestDb();
    const { scheduler, cancelled } = fakeScheduler();
    await scheduleReminder(db, { ...base, scheduledFor: 5000 }, scheduler);
    const stale = (await getReminderByMessageGuid(db, 'm1'))!;
    await rescheduleReminder(db, stale, 9000, scheduler);

    await expect(rescheduleReminder(db, stale, 12000, scheduler)).rejects.toThrow(
      'reminder no longer exists',
    );
    expect(await getReminderByMessageGuid(db, 'm1')).toMatchObject({
      scheduledFor: 9000,
      notificationId: reminderId(9000),
    });
    expect(cancelled).toContain(reminderId(12000));
    expect(cancelled).not.toContain(reminderId(9000));
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

describe('reminder repository serialization', () => {
  const reminder = (messageGuid: string, notificationId: string, scheduledFor: number) => ({
    messageGuid,
    chatGuid: 'c1',
    messagePreview: null,
    senderName: null,
    scheduledFor,
    notificationId,
  });

  it('rolls back the context-only notification-id delete when its commit guard is revoked', async () => {
    const { db, raw } = await createTestDb();
    const notificationId = 'scoped-delete';
    const id = await createReminder(db, reminder('scoped-delete', notificationId, 1000));

    let current = true;
    let triggerRan = false;
    raw.function('revoke_reminder_notification_delete_guard', () => {
      triggerRan = true;
      current = false;
      return 0;
    });
    raw.exec(`
      CREATE TRIGGER revoke_reminder_notification_delete_guard
      AFTER DELETE ON reminders
      WHEN OLD.id = ${id}
      BEGIN
        SELECT revoke_reminder_notification_delete_guard();
      END
    `);

    try {
      await expect(
        withDbTransaction(
          db,
          (context) => deleteReminderByNotificationIdWithinTransaction(context, notificationId),
          () => current,
        ),
      ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);

      expect(triggerRan).toBe(true);
      expect(await getReminderByMessageGuid(db, 'scoped-delete')).toMatchObject({ id });

      raw.exec('DROP TRIGGER revoke_reminder_notification_delete_guard');
      current = true;
      await withDbTransaction(db, (context) =>
        deleteReminderByNotificationIdWithinTransaction(context, notificationId),
      );
      expect(await getReminderByMessageGuid(db, 'scoped-delete')).toBeNull();
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS revoke_reminder_notification_delete_guard');
    }
  });

  it('queues create, move, and both delete shapes behind a rolling-back neighbour', async () => {
    const { db } = await createTestDb();
    const moveId = await createReminder(db, reminder('move', 'move-old', 1000));
    const deleteId = await createReminder(db, reminder('delete-id', 'delete-id', 2000));
    await createReminder(db, reminder('delete-notification', 'delete-notification', 3000));

    let releaseNeighbour!: () => void;
    let neighbourStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(db, async () => {
      neighbourStarted();
      await release;
      throw new Error('neighbour rollback');
    });
    await started;

    const created = createReminder(db, reminder('create', 'create', 4000));
    const moved = updateReminderTime(db, moveId, 5000, 'move-new');
    const deletedById = deleteReminder(db, deleteId);
    const deletedByNotification = deleteReminderByNotificationId(db, 'delete-notification');
    await Promise.resolve();
    expect(await listReminders(db)).toHaveLength(3);
    expect(await getReminderByMessageGuid(db, 'move')).toMatchObject({
      scheduledFor: 1000,
      notificationId: 'move-old',
    });

    releaseNeighbour();
    await expect(neighbour).rejects.toThrow('neighbour rollback');
    await expect(created).resolves.toEqual(expect.any(Number));
    await expect(moved).resolves.toBe(true);
    await Promise.all([deletedById, deletedByNotification]);
    expect(await listReminders(db)).toHaveLength(2);
    expect(await getReminderByMessageGuid(db, 'move')).toMatchObject({
      scheduledFor: 5000,
      notificationId: 'move-new',
    });
    expect(await getReminderByMessageGuid(db, 'create')).not.toBeNull();
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
