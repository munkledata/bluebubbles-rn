import { Chat, Message } from '@core/models';
import { sql } from 'drizzle-orm';
import notifee from 'react-native-notify-kit';
import * as Crypto from 'expo-crypto';
import {
  createReminder,
  getReminderByMessageGuid,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  chatNotificationId,
  clearNotificationRoutes,
  deleteFaceTimeRoute,
  faceTimeNotificationId,
  findFaceTimeRoute,
  getOrCreateFaceTimeRoute,
  isSafeReminderNotificationId,
  listFutureReminderTriggerRoutes,
  localFailedMessageRoute,
  localRouteForGuids,
  localRouteForMessageGuid,
  migrateReminderNotificationId,
  nativeFaceTimeData,
  nativeRouteData,
  newReminderNotificationId,
  replacementReminderNotificationId,
  resolveNotificationData,
  sendFailureNotificationId,
} from '@/services/notifications/notificationRouting';
import { cancelAllNotifications } from '@/services/notifications/notifeeService';
import { createTestDb } from '../support/testDb';

let mockDb: AppDatabase;
jest.mock('@/services/databaseControl', () => ({
  ensureDatabase: jest.fn(async () => mockDb),
}));
jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(() => '7f000000-0000-4000-8000-000000000001'),
}));
jest.mock('react-native-notify-kit', () => ({
  __esModule: true,
  default: {
    cancelAllNotifications: jest.fn(async () => undefined),
    getChannels: jest.fn(async () => []),
  },
}));

const mockCancelAllNotifications = notifee.cancelAllNotifications as jest.Mock;
const mockRandomUuid = Crypto.randomUUID as jest.Mock;
type RawDb = Awaited<ReturnType<typeof createTestDb>>['raw'];
let mockRaw: RawDb;

const nextEventLoopTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

interface DriverGate {
  didStart: boolean;
  held: Promise<void>;
  finished: Promise<void>;
  release(): void;
  markFinished(): void;
}

function driverGate(): DriverGate {
  let release!: () => void;
  let markFinished!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve;
  });
  return { didStart: false, held, finished, release, markFinished };
}

async function waitForCondition(condition: () => boolean, label: string): Promise<void> {
  for (let turn = 0; turn < 20 && !condition(); turn += 1) {
    await nextEventLoopTurn();
  }
  if (!condition()) throw new Error(`${label} did not start within 20 event-loop turns`);
}

function errorMessageChain(error: unknown): unknown[] {
  const messages: unknown[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current != null; depth += 1) {
    const record = current as { message?: unknown; cause?: unknown };
    messages.push(record.message);
    current = record.cause;
  }
  return messages;
}

function rollingBackNeighbour(
  db: AppDatabase,
  raw: RawDb,
  phantomKey: string,
  sentinel: string,
): {
  state: { didStart: boolean };
  release(): void;
  outcome: Promise<{ kind: 'resolved'; value: void } | { kind: 'rejected'; message: string }>;
} {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { didStart: false };
  const outcome = withDbTransaction(db, async () => {
    raw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(phantomKey, 'rollback');
    state.didStart = true;
    await held;
    throw new Error(sentinel);
  }).then(
    (value) => ({ kind: 'resolved' as const, value }),
    (error: unknown) => ({ kind: 'rejected' as const, message: String(error) }),
  );
  return { state, release, outcome };
}

async function seedMessage(db: AppDatabase): Promise<void> {
  const handles = await upsertHandles(db, [{ address: '+15551234567' }]);
  const chatMap = await upsertChats(
    db,
    [
      Chat.parse({
        guid: 'iMessage;-;+15551234567',
        displayName: 'Alice',
        participants: [{ address: '+15551234567' }],
      }),
    ],
    handles,
  );
  await upsertMessages(
    db,
    [Message.parse({ guid: 'p:0/private-message-guid', text: 'secret', dateCreated: 100 })],
    () => chatMap.get('iMessage;-;+15551234567')!,
    handles,
  );
}

beforeEach(async () => {
  ({ db: mockDb, raw: mockRaw } = await createTestDb());
  await seedMessage(mockDb);
});

describe('notificationRouting — native privacy boundary', () => {
  it('round-trips a message through local integer keys without serializing raw identifiers', async () => {
    const route = await localRouteForGuids('iMessage;-;+15551234567', 'p:0/private-message-guid');
    expect(route?.chatId).toEqual(expect.any(Number));
    expect(route?.messageId).toEqual(expect.any(Number));

    const data = nativeRouteData('message', route!, 123);
    const id = chatNotificationId(route!.chatId);
    const serializedNativeState = JSON.stringify({ id, data });
    expect(serializedNativeState).not.toMatch(/15551234567|private-message-guid|iMessage/);
    expect(data).toEqual(
      expect.objectContaining({
        gatorOwner: 'gator',
        gatorSchema: '2',
        gatorKind: 'message',
      }),
    );

    await expect(resolveNotificationData(data)).resolves.toEqual({
      chatGuid: 'iMessage;-;+15551234567',
      messageGuid: 'p:0/private-message-guid',
      messageDate: '123',
    });
  });

  it('round-trips a failed send through local integer keys without exposing message or chat identifiers', async () => {
    mockRaw
      .prepare(
        `UPDATE messages
            SET is_from_me = 1, send_state = 'error'
          WHERE guid = ?`,
      )
      .run('p:0/private-message-guid');

    const localRoute = await localRouteForMessageGuid('p:0/private-message-guid', mockDb);
    const failed = await localFailedMessageRoute('p:0/private-message-guid', mockDb);
    expect(failed).toEqual({
      chatGuid: 'iMessage;-;+15551234567',
      messageGuid: 'p:0/private-message-guid',
      route: localRoute,
    });

    const data = nativeRouteData('send-failure', failed!.route);
    const id = sendFailureNotificationId(failed!.route.messageId);
    expect(JSON.stringify({ id, data })).not.toMatch(/15551234567|private-message-guid|iMessage/);
    expect(data).toEqual({
      gatorOwner: 'gator',
      gatorSchema: '2',
      gatorKind: 'send-failure',
      chatId: String(failed!.route.chatId),
      messageId: String(failed!.route.messageId),
    });
    await expect(resolveNotificationData(data)).resolves.toEqual({
      chatGuid: 'iMessage;-;+15551234567',
      messageGuid: 'p:0/private-message-guid',
    });
  });

  it('resolves a failed-send route only while current DB truth is an undeleted outgoing error', async () => {
    const setState = mockRaw.prepare(
      `UPDATE messages
          SET is_from_me = ?, send_state = ?, date_deleted = ?, date_retracted = ?
        WHERE guid = ?`,
    );

    setState.run(0, 'error', null, null, 'p:0/private-message-guid');
    await expect(localFailedMessageRoute('p:0/private-message-guid', mockDb)).resolves.toBeNull();

    setState.run(1, 'error', null, null, 'p:0/private-message-guid');
    await expect(localFailedMessageRoute('p:0/private-message-guid', mockDb)).resolves.toEqual(
      expect.objectContaining({
        chatGuid: 'iMessage;-;+15551234567',
        messageGuid: 'p:0/private-message-guid',
      }),
    );

    setState.run(1, 'sending', null, null, 'p:0/private-message-guid');
    await expect(localFailedMessageRoute('p:0/private-message-guid', mockDb)).resolves.toBeNull();

    setState.run(1, 'error', 200, null, 'p:0/private-message-guid');
    await expect(localFailedMessageRoute('p:0/private-message-guid', mockDb)).resolves.toBeNull();

    setState.run(1, 'error', null, 300, 'p:0/private-message-guid');
    await expect(localFailedMessageRoute('p:0/private-message-guid', mockDb)).resolves.toBeNull();
  });

  it('retains the same local failure-notice id when a stale temp guid resolves through its alias', async () => {
    mockRaw
      .prepare(
        `INSERT INTO message_guid_aliases (alias_guid, canonical_guid)
         VALUES (?, ?)`,
      )
      .run('temp-stale-failure-guid', 'p:0/private-message-guid');

    await expect(localRouteForMessageGuid('temp-stale-failure-guid', mockDb)).resolves.toEqual(
      await localRouteForMessageGuid('p:0/private-message-guid', mockDb),
    );
  });

  it('stores a server-controlled FaceTime UUID behind a random encrypted-DB token', async () => {
    const uuid = 'attacker-controlled-phone@example.com';
    const token = await getOrCreateFaceTimeRoute(uuid);
    const data = nativeFaceTimeData(token);
    const id = faceTimeNotificationId(token);
    expect(JSON.stringify({ id, data })).not.toContain(uuid);
    await expect(resolveNotificationData(data)).resolves.toEqual({ faceTimeUuid: uuid });
    await expect(getOrCreateFaceTimeRoute(uuid)).resolves.toBe(token);
  });

  it('does not return a FaceTime route that a neighbouring transaction rolls back', async () => {
    const uuid = 'phantom-call-uuid';
    const phantomToken = '7f000000-0000-4000-8000-000000000001';
    const durableToken = '7f000000-0000-4000-8000-000000000002';
    mockRandomUuid.mockReturnValueOnce(durableToken);

    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(mockDb, async () => {
      await mockDb.run(sql`
        INSERT INTO kv (key, value)
        VALUES (${`notification.route.v2.facetime.${phantomToken}`}, ${uuid})
      `);
      neighbourStarted();
      await held;
      throw new Error('neighbour rollback');
    });
    await started;

    let routeSettled = false;
    const route = getOrCreateFaceTimeRoute(uuid).then((value) => {
      routeSettled = true;
      return value;
    });
    await Promise.resolve();
    expect(routeSettled).toBe(false);

    releaseNeighbour();
    await expect(neighbour).rejects.toThrow('neighbour rollback');
    await expect(route).resolves.toBe(durableToken);
    await expect(resolveNotificationData(nativeFaceTimeData(phantomToken))).resolves.toBeNull();
    await expect(resolveNotificationData(nativeFaceTimeData(durableToken))).resolves.toEqual({
      faceTimeUuid: uuid,
    });
  });

  it('rejects a queued FaceTime route when its account commit guard is revoked', async () => {
    const uuid = 'revoked-call-uuid';
    let releaseNeighbour!: () => void;
    let neighbourStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(mockDb, async () => {
      neighbourStarted();
      await held;
    });
    await started;

    let current = true;
    const route = getOrCreateFaceTimeRoute(uuid, () => current);
    await Promise.resolve();
    current = false;
    releaseNeighbour();
    await neighbour;

    await expect(route).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    await expect(findFaceTimeRoute(uuid)).resolves.toBeNull();
  });

  it('clears the encrypted FaceTime route table during account teardown', async () => {
    const uuid = 'old-account-call-uuid';
    const token = await getOrCreateFaceTimeRoute(uuid);
    const data = nativeFaceTimeData(token);
    await expect(resolveNotificationData(data)).resolves.toEqual({ faceTimeUuid: uuid });

    await clearNotificationRoutes();

    await expect(resolveNotificationData(data)).resolves.toBeNull();
  });

  it('queues an exact FaceTime-route delete and awaits its driver before committing', async () => {
    const targetToken = '7f000000-0000-4000-8000-000000000010';
    const bystanderToken = '7f000000-0000-4000-8000-000000000011';
    const targetKey = `notification.route.v2.facetime.${targetToken}`;
    const bystanderKey = `notification.route.v2.facetime.${bystanderToken}`;
    const globalKey = 'sync.messagesPerChat';
    const insert = mockRaw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)');
    insert.run(targetKey, 'target-call');
    insert.run(bystanderKey, 'bystander-call');
    insert.run(globalKey, '25');

    const neighbour = rollingBackNeighbour(
      mockDb,
      mockRaw,
      'notification.route.delete.phantom',
      'route-delete neighbour rollback',
    );
    const deleteDriver = driverGate();
    type Run = (query: unknown) => unknown;
    const realRun = mockDb.run.bind(mockDb) as Run;
    const runSpy = jest.spyOn(mockDb, 'run').mockImplementation(((query: unknown) => {
      const shape = JSON.stringify(query).replace(/\s+/g, ' ').toLowerCase();
      if (
        !deleteDriver.didStart &&
        shape.includes('delete from kv') &&
        shape.includes('where key =') &&
        shape.includes(targetKey)
      ) {
        deleteDriver.didStart = true;
        const delayed = deleteDriver.held
          .then(() => realRun(query))
          .finally(deleteDriver.markFinished);
        void delayed.catch(() => {});
        return delayed;
      }
      return realRun(query);
    }) as unknown as AppDatabase['run']);

    let deleteSettled = false;
    let deleteOutcome:
      Promise<{ kind: 'resolved'; value: void } | { kind: 'rejected'; error: unknown }> | undefined;
    try {
      await waitForCondition(() => neighbour.state.didStart, 'route-delete neighbour');
      deleteOutcome = deleteFaceTimeRoute(targetToken)
        .then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        )
        .finally(() => {
          deleteSettled = true;
        });
      await nextEventLoopTurn();
      expect(deleteSettled).toBe(false);
      expect(deleteDriver.didStart).toBe(false);
      expect(mockRaw.inTransaction).toBe(true);
      expect(mockRaw.prepare('SELECT value FROM kv WHERE key = ?').get(targetKey)).toEqual({
        value: 'target-call',
      });
      expect(
        mockRaw
          .prepare("SELECT value FROM kv WHERE key = 'notification.route.delete.phantom'")
          .get(),
      ).toEqual({ value: 'rollback' });

      neighbour.release();
      await expect(neighbour.outcome).resolves.toEqual({
        kind: 'rejected',
        message: 'Error: route-delete neighbour rollback',
      });
      await waitForCondition(() => deleteDriver.didStart, 'exact FaceTime-route delete');
      await nextEventLoopTurn();
      expect(deleteSettled).toBe(false);
      expect(mockRaw.inTransaction).toBe(true);
      expect(mockRaw.prepare('SELECT value FROM kv WHERE key = ?').get(targetKey)).toEqual({
        value: 'target-call',
      });
      expect(mockRaw.prepare('SELECT value FROM kv WHERE key = ?').get(bystanderKey)).toEqual({
        value: 'bystander-call',
      });
      expect(mockRaw.prepare('SELECT value FROM kv WHERE key = ?').get(globalKey)).toEqual({
        value: '25',
      });

      deleteDriver.release();
      await deleteDriver.finished;
      await expect(deleteOutcome).resolves.toEqual({ kind: 'resolved', value: undefined });
      expect(mockRaw.inTransaction).toBe(false);
      expect(mockRaw.prepare('SELECT value FROM kv WHERE key = ?').get(targetKey)).toBeUndefined();
      expect(mockRaw.prepare('SELECT value FROM kv WHERE key = ?').get(bystanderKey)).toEqual({
        value: 'bystander-call',
      });
      expect(mockRaw.prepare('SELECT value FROM kv WHERE key = ?').get(globalKey)).toEqual({
        value: '25',
      });
    } finally {
      neighbour.release();
      deleteDriver.release();
      const drains: Promise<unknown>[] = [neighbour.outcome];
      if (deleteOutcome) drains.push(deleteOutcome);
      if (deleteDriver.didStart) drains.push(deleteDriver.finished);
      await Promise.allSettled(drains);
      runSpy.mockRestore();
    }
  });

  it('rejects a queued FaceTime-route delete when its account commit guard is revoked', async () => {
    const token = '7f000000-0000-4000-8000-000000000012';
    const key = `notification.route.v2.facetime.${token}`;
    mockRaw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(key, 'retired-call');

    let releaseNeighbour!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(mockDb, async () => {
      markStarted();
      await held;
    });
    await started;

    let current = true;
    const deletion = deleteFaceTimeRoute(token, () => current);
    await nextEventLoopTurn();
    current = false;
    releaseNeighbour();
    await neighbour;

    await expect(deletion).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    expect(mockRaw.prepare('SELECT value FROM kv WHERE key = ?').get(key)).toEqual({
      value: 'retired-call',
    });
  });

  it('clears FaceTime routes in two awaited 500-row transactions without widening scope', async () => {
    const routePrefix = 'notification.route.v2.facetime.';
    const finalRouteKey = `${routePrefix}bulk-500`;
    const triggerName = 'reject_final_notification_route_delete';
    const canary = 'NOTIFICATION_ROUTE_FINAL_DELETE_RAW_CANARY';
    const insert = mockRaw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)');
    mockRaw.transaction(() => {
      for (let index = 0; index < 501; index += 1) {
        insert.run(`${routePrefix}bulk-${String(index).padStart(3, '0')}`, `call-${index}`);
      }
      insert.run('notification.route.v2.facetime-near-prefix', 'keep-near-prefix');
      insert.run('sync.messagesPerChat', '50');
    })();
    mockRaw.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE DELETE ON kv
      WHEN OLD.key = '${finalRouteKey}'
      BEGIN
        SELECT RAISE(ABORT, '${canary}');
      END
    `);
    const routeCount = (): number =>
      (
        mockRaw
          .prepare(
            "SELECT COUNT(*) AS count FROM kv WHERE key LIKE 'notification.route.v2.facetime.%'",
          )
          .get() as { count: number }
      ).count;

    const neighbour = rollingBackNeighbour(
      mockDb,
      mockRaw,
      'notification.route.clear.phantom',
      'route-clear neighbour rollback',
    );
    const firstBatch = driverGate();
    const secondBatch = driverGate();
    type All = (query: unknown) => unknown;
    const realAll = mockDb.all.bind(mockDb) as All;
    const allSpy = jest.spyOn(mockDb, 'all').mockImplementation(((query: unknown) => {
      const shape = JSON.stringify(query).replace(/\s+/g, ' ').toLowerCase();
      if (
        shape.includes('delete from kv') &&
        shape.includes('select rowid') &&
        shape.includes('key like') &&
        shape.includes('limit 500') &&
        shape.includes('returning rowid')
      ) {
        const gate = !firstBatch.didStart
          ? firstBatch
          : secondBatch.didStart
            ? undefined
            : secondBatch;
        if (gate) {
          gate.didStart = true;
          const delayed = gate.held.then(() => realAll(query)).finally(gate.markFinished);
          void delayed.catch(() => {});
          return delayed;
        }
      }
      return realAll(query);
    }) as unknown as AppDatabase['all']);

    let clearSettled = false;
    let clearOutcome:
      Promise<{ kind: 'resolved'; value: void } | { kind: 'rejected'; error: unknown }> | undefined;
    try {
      await waitForCondition(() => neighbour.state.didStart, 'route-clear neighbour');
      clearOutcome = clearNotificationRoutes()
        .then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        )
        .finally(() => {
          clearSettled = true;
        });
      await nextEventLoopTurn();
      expect(clearSettled).toBe(false);
      expect(firstBatch.didStart).toBe(false);
      expect(secondBatch.didStart).toBe(false);
      expect(routeCount()).toBe(501);
      expect(mockRaw.inTransaction).toBe(true);

      neighbour.release();
      await expect(neighbour.outcome).resolves.toEqual({
        kind: 'rejected',
        message: 'Error: route-clear neighbour rollback',
      });
      await waitForCondition(() => firstBatch.didStart, 'first notification-route batch');
      await nextEventLoopTurn();
      expect(clearSettled).toBe(false);
      expect(mockRaw.inTransaction).toBe(true);
      expect(routeCount()).toBe(501);
      expect(secondBatch.didStart).toBe(false);

      firstBatch.release();
      await firstBatch.finished;
      await waitForCondition(() => secondBatch.didStart, 'second notification-route batch');
      await nextEventLoopTurn();
      expect(clearSettled).toBe(false);
      expect(mockRaw.inTransaction).toBe(true);
      expect(routeCount()).toBe(1);

      secondBatch.release();
      await secondBatch.finished;
      const failed = await clearOutcome;
      expect(failed.kind).toBe('rejected');
      if (failed.kind === 'rejected') expect(errorMessageChain(failed.error)).toContain(canary);
      expect(mockRaw.inTransaction).toBe(false);
      // Batch one committed independently; only the exact final-row batch rolled back.
      expect(routeCount()).toBe(1);
      expect(mockRaw.prepare('SELECT value FROM kv WHERE key = ?').get(finalRouteKey)).toEqual({
        value: 'call-500',
      });
      expect(
        mockRaw
          .prepare("SELECT value FROM kv WHERE key = 'notification.route.v2.facetime-near-prefix'")
          .get(),
      ).toEqual({ value: 'keep-near-prefix' });
      expect(
        mockRaw.prepare("SELECT value FROM kv WHERE key = 'sync.messagesPerChat'").get(),
      ).toEqual({ value: '50' });
      expect(
        mockRaw
          .prepare("SELECT value FROM kv WHERE key = 'notification.route.clear.phantom'")
          .get(),
      ).toBeUndefined();

      mockRaw.exec(`DROP TRIGGER ${triggerName}`);
      await expect(clearNotificationRoutes()).resolves.toBeUndefined();
      expect(routeCount()).toBe(0);
      expect(
        mockRaw.prepare('SELECT value FROM kv WHERE key = ?').get(finalRouteKey),
      ).toBeUndefined();
      expect(
        mockRaw
          .prepare("SELECT value FROM kv WHERE key = 'notification.route.v2.facetime-near-prefix'")
          .get(),
      ).toEqual({ value: 'keep-near-prefix' });
      expect(
        mockRaw.prepare("SELECT value FROM kv WHERE key = 'sync.messagesPerChat'").get(),
      ).toEqual({ value: '50' });
    } finally {
      neighbour.release();
      firstBatch.release();
      secondBatch.release();
      const drains: Promise<unknown>[] = [neighbour.outcome];
      if (clearOutcome) drains.push(clearOutcome);
      if (firstBatch.didStart) drains.push(firstBatch.finished);
      if (secondBatch.didStart) drains.push(secondBatch.finished);
      await Promise.allSettled(drains);
      mockRaw.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
      allSpy.mockRestore();
    }
  });

  it('composes native cancellation with clearing every encrypted notification route', async () => {
    mockRandomUuid
      .mockReturnValueOnce('7f000000-0000-4000-8000-000000000001')
      .mockReturnValueOnce('7f000000-0000-4000-8000-000000000002');
    const firstToken = await getOrCreateFaceTimeRoute('first-private-call-uuid');
    const secondToken = await getOrCreateFaceTimeRoute('second-private-call-uuid');
    const routeCount = async (): Promise<number> => {
      const rows = await mockDb.all<{ count: number }>(sql`
        SELECT COUNT(*) AS count
        FROM kv
        WHERE key LIKE 'notification.route.v2.facetime.%'
      `);
      return Number(rows[0]?.count ?? 0);
    };
    expect(await routeCount()).toBe(2);

    await cancelAllNotifications();

    expect(mockCancelAllNotifications).toHaveBeenCalledTimes(1);
    expect(await routeCount()).toBe(0);
    await expect(resolveNotificationData(nativeFaceTimeData(firstToken))).resolves.toBeNull();
    await expect(resolveNotificationData(nativeFaceTimeData(secondToken))).resolves.toBeNull();
  });

  it('mints and migrates reminder ids without embedding the message GUID', async () => {
    const safeId = await newReminderNotificationId(mockDb, 'p:0/private-message-guid', 5000);
    expect(safeId).toMatch(/^gator-reminder-message-\d+-5000$/);
    expect(safeId).not.toContain('private-message-guid');
    expect(isSafeReminderNotificationId(safeId)).toBe(true);
    expect(isSafeReminderNotificationId('gator-reminder-+15551234567-5000')).toBe(false);

    await createReminder(mockDb, {
      chatGuid: 'iMessage;-;+15551234567',
      messageGuid: 'p:0/private-message-guid',
      messagePreview: 'secret',
      senderName: 'Alice',
      scheduledFor: 5000,
      notificationId: 'reminder-p:0/private-message-guid-5000',
    });
    const replacement = await replacementReminderNotificationId(
      'reminder-p:0/private-message-guid-5000',
      'p:0/private-message-guid',
    );
    expect(replacement).toBe(safeId);
    await expect(
      migrateReminderNotificationId('reminder-p:0/private-message-guid-5000', replacement!),
    ).resolves.toBe(true);
    expect(
      (await getReminderByMessageGuid(mockDb, 'p:0/private-message-guid'))?.notificationId,
    ).toBe(safeId);
  });

  it('queues and awaits an exact reminder-id handoff before releasing the next writer', async () => {
    const oldId = 'reminder-p:0/private-message-guid-6500';
    const newId = 'gator-reminder-message-1-6500';
    const missingOldId = 'reminder-p:0/missing-message-guid-6500';
    const missingNewId = 'gator-reminder-row-999-6500';
    await createReminder(mockDb, {
      chatGuid: 'iMessage;-;+15551234567',
      messageGuid: 'p:0/private-message-guid',
      messagePreview: 'secret',
      senderName: 'Alice',
      scheduledFor: 6500,
      notificationId: oldId,
    });
    const notificationId = (): string | undefined =>
      (
        mockRaw
          .prepare('SELECT notification_id AS notificationId FROM reminders WHERE message_guid = ?')
          .get('p:0/private-message-guid') as { notificationId: string } | undefined
      )?.notificationId;
    const countNotificationId = (id: string): number =>
      (
        mockRaw
          .prepare('SELECT COUNT(*) AS count FROM reminders WHERE notification_id = ?')
          .get(id) as {
          count: number;
        }
      ).count;

    const neighbour = rollingBackNeighbour(
      mockDb,
      mockRaw,
      'notification.reminder-migration.phantom',
      'reminder migration neighbour rollback',
    );
    const updateDriver = driverGate();
    let fallbackSelects = 0;
    type All = (query: unknown) => unknown;
    const realAll = mockDb.all.bind(mockDb) as All;
    const allSpy = jest.spyOn(mockDb, 'all').mockImplementation(((query: unknown) => {
      const shape = JSON.stringify(query).replace(/\s+/g, ' ').toLowerCase();
      const exactUpdate =
        shape.includes('update reminders set notification_id') &&
        shape.includes('where notification_id') &&
        shape.includes('returning id') &&
        shape.includes(oldId.toLowerCase()) &&
        shape.includes(newId.toLowerCase());
      if (exactUpdate && !updateDriver.didStart) {
        updateDriver.didStart = true;
        const delayed = updateDriver.held
          .then(() => realAll(query))
          .finally(updateDriver.markFinished);
        void delayed.catch(() => {});
        return delayed;
      }
      if (
        shape.includes('select id from reminders where notification_id') &&
        shape.includes(newId.toLowerCase())
      ) {
        fallbackSelects += 1;
      }
      return realAll(query);
    }) as unknown as AppDatabase['all']);

    let migrationSettled = false;
    let successorStarted = false;
    let successorSettled = false;
    let migrationOutcome:
      | Promise<{ kind: 'resolved'; value: boolean } | { kind: 'rejected'; error: unknown }>
      | undefined;
    let successorOutcome:
      Promise<{ kind: 'resolved'; value: void } | { kind: 'rejected'; error: unknown }> | undefined;
    try {
      await waitForCondition(() => neighbour.state.didStart, 'reminder migration neighbour');
      migrationOutcome = migrateReminderNotificationId(oldId, newId)
        .then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        )
        .finally(() => {
          migrationSettled = true;
        });
      await nextEventLoopTurn();

      expect(migrationSettled).toBe(false);
      expect(updateDriver.didStart).toBe(false);
      expect(notificationId()).toBe(oldId);
      expect(countNotificationId(newId)).toBe(0);
      expect(
        mockRaw
          .prepare("SELECT value FROM kv WHERE key = 'notification.reminder-migration.phantom'")
          .get(),
      ).toEqual({ value: 'rollback' });

      neighbour.release();
      await expect(neighbour.outcome).resolves.toEqual({
        kind: 'rejected',
        message: 'Error: reminder migration neighbour rollback',
      });
      await waitForCondition(() => updateDriver.didStart, 'exact reminder-id update');

      successorOutcome = withDbTransaction(mockDb, async () => {
        successorStarted = true;
      })
        .then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        )
        .finally(() => {
          successorSettled = true;
        });
      await nextEventLoopTurn();

      expect(mockRaw.inTransaction).toBe(true);
      expect(migrationSettled).toBe(false);
      expect(notificationId()).toBe(oldId);
      expect(countNotificationId(newId)).toBe(0);
      expect(fallbackSelects).toBe(0);
      expect(successorStarted).toBe(false);
      expect(successorSettled).toBe(false);

      updateDriver.release();
      await updateDriver.finished;
      await waitForCondition(() => successorStarted, 'reminder migration successor');
      await expect(migrationOutcome).resolves.toEqual({ kind: 'resolved', value: true });
      await expect(successorOutcome).resolves.toEqual({ kind: 'resolved', value: undefined });
      expect(mockRaw.inTransaction).toBe(false);
      expect(notificationId()).toBe(newId);
      expect(countNotificationId(oldId)).toBe(0);
      expect(countNotificationId(newId)).toBe(1);

      await expect(migrateReminderNotificationId(oldId, newId)).resolves.toBe(true);
      expect(fallbackSelects).toBe(1);
      expect(notificationId()).toBe(newId);
      await expect(migrateReminderNotificationId(missingOldId, missingNewId)).resolves.toBe(false);
      expect(notificationId()).toBe(newId);
    } finally {
      neighbour.release();
      updateDriver.release();
      const drains: Promise<unknown>[] = [neighbour.outcome];
      if (migrationOutcome) drains.push(migrationOutcome);
      if (successorOutcome) drains.push(successorOutcome);
      if (updateDriver.didStart) drains.push(updateDriver.finished);
      await Promise.allSettled(drains);
      allSpy.mockRestore();
    }
  });

  it('rejects a queued reminder-id migration when its account commit guard is revoked', async () => {
    const oldId = 'reminder-p:0/private-message-guid-7000';
    const newId = 'gator-reminder-message-1-7000';
    await createReminder(mockDb, {
      chatGuid: 'iMessage;-;+15551234567',
      messageGuid: 'p:0/private-message-guid',
      messagePreview: 'secret',
      senderName: 'Alice',
      scheduledFor: 7000,
      notificationId: oldId,
    });

    const neighbour = rollingBackNeighbour(
      mockDb,
      mockRaw,
      'notification.reminder-revoked.phantom',
      'reminder revoked neighbour rollback',
    );
    let current = true;
    let migrationSettled = false;
    let migrationOutcome:
      | Promise<{ kind: 'resolved'; value: boolean } | { kind: 'rejected'; error: unknown }>
      | undefined;
    try {
      await waitForCondition(() => neighbour.state.didStart, 'revoked reminder neighbour');
      migrationOutcome = migrateReminderNotificationId(oldId, newId, () => current)
        .then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        )
        .finally(() => {
          migrationSettled = true;
        });
      await nextEventLoopTurn();
      expect(migrationSettled).toBe(false);

      current = false;
      neighbour.release();
      await expect(neighbour.outcome).resolves.toEqual({
        kind: 'rejected',
        message: 'Error: reminder revoked neighbour rollback',
      });
      const outcome = await migrationOutcome;
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') {
        expect(outcome.error).toBeInstanceOf(DbCommitGuardRejectedError);
      }

      expect(
        (await getReminderByMessageGuid(mockDb, 'p:0/private-message-guid'))?.notificationId,
      ).toBe(oldId);
      const newRows = await mockDb.all<{ id: number }>(sql`
        SELECT id FROM reminders WHERE notification_id = ${newId}
      `);
      expect(newRows).toEqual([]);
    } finally {
      current = false;
      neighbour.release();
      const drains: Promise<unknown>[] = [neighbour.outcome];
      if (migrationOutcome) drains.push(migrationOutcome);
      await Promise.allSettled(drains);
    }
  });

  it('reconstructs only future durable reminders with native-safe local routes', async () => {
    await createReminder(mockDb, {
      chatGuid: 'iMessage;-;+15551234567',
      messageGuid: 'p:0/private-message-guid',
      messagePreview: 'past private preview',
      senderName: 'Alice',
      scheduledFor: 900,
      notificationId: 'reminder-p:0/private-message-guid-900',
    });
    await createReminder(mockDb, {
      chatGuid: 'iMessage;-;+15551234567',
      messageGuid: 'p:0/private-message-guid',
      messagePreview: 'future private preview',
      senderName: 'Alice',
      scheduledFor: 1500,
      notificationId: 'reminder-p:0/private-message-guid-1500',
    });
    await createReminder(mockDb, {
      chatGuid: 'iMessage;-;+15551234567',
      messageGuid: 'missing-private-message-guid',
      messagePreview: 'future missing-message preview',
      senderName: 'Alice',
      scheduledFor: 1600,
      notificationId: 'legacy-private-id-1600',
    });

    const routes = await listFutureReminderTriggerRoutes(1000);

    expect(routes).toHaveLength(2);
    expect(routes[0]).toEqual(
      expect.objectContaining({
        oldId: 'reminder-p:0/private-message-guid-1500',
        newId: expect.stringMatching(/^gator-reminder-message-\d+-1500$/),
        scheduledFor: 1500,
        route: expect.objectContaining({
          chatId: expect.any(Number),
          messageId: expect.any(Number),
        }),
        messageDate: 100,
      }),
    );
    expect(routes[1]).toEqual(
      expect.objectContaining({
        oldId: 'legacy-private-id-1600',
        newId: expect.stringMatching(/^gator-reminder-row-\d+-1600$/),
        scheduledFor: 1600,
        route: { chatId: expect.any(Number) },
      }),
    );
    expect(routes[1]).not.toHaveProperty('messageDate');
    expect(routes.map(({ newId, route }) => JSON.stringify({ newId, route })).join()).not.toMatch(
      /15551234567|private-message-guid|iMessage/,
    );
  });

  it('fails closed on foreign/new schemas while preserving legacy press compatibility', async () => {
    await expect(
      resolveNotificationData({
        gatorOwner: 'other-app',
        gatorSchema: '2',
        gatorKind: 'message',
        chatId: '1',
      }),
    ).resolves.toBeNull();
    await expect(
      resolveNotificationData({
        gatorOwner: 'gator',
        gatorSchema: '999',
        gatorKind: 'message',
        chatId: '1',
      }),
    ).resolves.toBeNull();
    await expect(
      resolveNotificationData({ chatGuid: 'legacy-chat', messageGuid: 'legacy-message' }),
    ).resolves.toEqual({ chatGuid: 'legacy-chat', messageGuid: 'legacy-message' });
  });
});
