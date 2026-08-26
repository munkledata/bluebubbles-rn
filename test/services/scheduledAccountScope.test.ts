/**
 * Account-generation barriers for production scheduled-message operations.
 *
 * These tests deliberately reopen admission before A's deferred await settles. Real Disconnect
 * now blocks B when its drain times out, but the service layer must remain safe even if that outer
 * policy regresses: an old lease can never become current again after the generation increments.
 */
import { Chat } from '@core/models';
import {
  claimScheduled,
  getScheduledById,
  insertScheduled,
  listAllScheduled,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/clients', () => ({ http: {} }));
jest.mock('@/services/contacts/contactsService', () => ({ pickContact: jest.fn() }));
jest.mock('@/services/send/attachmentUpload', () => ({
  expoAttachmentUploader: jest.fn(),
  expoFileExists: jest.fn(async () => true),
}));
jest.mock('@ui/toast/toastStore', () => ({ showToast: jest.fn() }));
jest.mock('@core/api/endpoints/scheduled', () => ({
  getScheduled: jest.fn(),
  createScheduled: jest.fn(),
  deleteScheduled: jest.fn(),
}));
jest.mock('@/services/send/sendService', () => ({
  generateTempGuid: jest.fn(() => 'temp-test'),
  sendTextMessage: jest.fn(),
}));

// eslint-disable-next-line import/first
import {
  cancelScheduled,
  editScheduled,
  fireDueScheduled,
  recoverStuckScheduled,
  schedule,
  syncScheduledFromServer,
} from '@/services/send';
// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';
// eslint-disable-next-line import/first
import {
  createScheduled,
  deleteScheduled as deleteServerScheduled,
  getScheduled,
} from '@core/api/endpoints/scheduled';
// eslint-disable-next-line import/first
import { sendTextMessage } from '@/services/send/sendService';
// eslint-disable-next-line import/first
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

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
  throw new Error('deferred operation did not reach its test seam');
}

async function seedChat(db: AppDatabase): Promise<void> {
  const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
  await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: [{ address: 'a@b.com' }] })],
    handles,
  );
}

const serverItem = (id: string, text = 'from A') => ({
  id,
  chatGuid: 'c1',
  text,
  scheduledFor: 9_000_000,
  status: 'pending',
});

const mockGetScheduled = getScheduled as jest.Mock;
const mockCreateScheduled = createScheduled as jest.Mock;
const mockDeleteScheduled = deleteServerScheduled as jest.Mock;
const mockSendTextMessage = sendTextMessage as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  resumeRealtimeDeliveries();
});

afterEach(async () => {
  await pauseRealtimeDeliveries();
  resumeRealtimeDeliveries();
});

describe('scheduled-message account ownership', () => {
  it('rejects delayed UI actions carrying an already-retired A lease before any request or write', async () => {
    const { db } = await createTestDb();
    await seedChat(db);
    (getDatabase as jest.Mock).mockReturnValue(db);
    const accountLease = captureRealtimeDeliveryLease();
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();

    await expect(
      schedule({ chatGuid: 'c1', text: 'stale callback', scheduledFor: 9_000_000 }, accountLease),
    ).rejects.toThrow('account session changed');
    await expect(cancelScheduled({ id: 7, serverId: 'srv-a' }, accountLease)).rejects.toThrow(
      'account session changed',
    );
    await expect(
      editScheduled(7, { text: 'stale edit', scheduledFor: 9_500_000 }, accountLease),
    ).rejects.toThrow('account session changed');

    expect(mockCreateScheduled).not.toHaveBeenCalled();
    expect(mockDeleteScheduled).not.toHaveBeenCalled();
    expect(await listAllScheduled(db)).toEqual([]);
  });

  it('does not insert A’s late schedule-create response after B becomes active', async () => {
    const { db } = await createTestDb();
    await seedChat(db);
    (getDatabase as jest.Mock).mockReturnValue(db);
    const response = deferred<ReturnType<typeof serverItem>>();
    mockCreateScheduled.mockReturnValue(response.promise);

    const pending = schedule({ chatGuid: 'c1', text: 'A secret', scheduledFor: 9_000_000 });
    await waitUntil(() => mockCreateScheduled.mock.calls.length === 1);
    const rejected = expect(pending).rejects.toThrow('account session changed');

    const drain = pauseRealtimeDeliveries();
    resumeRealtimeDeliveries(); // model B becoming active before the old native/network await ends
    response.resolve(serverItem('srv-a'));

    await rejected;
    await drain;
    expect(await listAllScheduled(db)).toEqual([]);
  });

  it('rolls back a local schedule insert when A retires inside the owner after server create', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db);
    (getDatabase as jest.Mock).mockReturnValue(db);
    let networkSawTransaction = true;
    mockCreateScheduled.mockImplementation(async () => {
      networkSawTransaction = raw.inTransaction;
      return serverItem('srv-created-before-retirement');
    });

    let drain: Promise<void> | undefined;
    raw.function('retire_schedule_during_insert', () => {
      drain = pauseRealtimeDeliveries();
      return 0;
    });
    raw.exec(`
      CREATE TRIGGER retire_schedule_during_insert
      AFTER INSERT ON scheduled_messages
      BEGIN
        SELECT retire_schedule_during_insert();
      END
    `);

    const action = schedule({
      chatGuid: 'c1',
      text: 'server already owns this',
      scheduledFor: 9_000_000,
    });
    try {
      await expect(action).rejects.toThrow('account session changed');
      if (!drain) throw new Error('scheduled create did not revoke the account lease');
      await drain;
    } finally {
      resumeRealtimeDeliveries();
    }

    expect(networkSawTransaction).toBe(false);
    expect(mockCreateScheduled).toHaveBeenCalledTimes(1);
    expect(raw.inTransaction).toBe(false);
    expect(await listAllScheduled(db)).toEqual([]);
  });

  it('does not reconcile a slow A scheduled-list response into B', async () => {
    const { db } = await createTestDb();
    await seedChat(db);
    (getDatabase as jest.Mock).mockReturnValue(db);
    await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'existing',
      scheduledFor: 9_000_000,
      serverId: 'srv-existing',
    });
    const response = deferred<ReturnType<typeof serverItem>[]>();
    mockGetScheduled.mockReturnValue(response.promise);

    const pending = syncScheduledFromServer();
    await waitUntil(() => mockGetScheduled.mock.calls.length === 1);
    const drain = pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    response.resolve([serverItem('srv-late-a')]);

    await pending;
    await drain;
    expect((await listAllScheduled(db)).map((row) => row.serverId)).toEqual(['srv-existing']);
  });

  it('does not call the real sender for an A due-list that resolves after B', async () => {
    const { db } = await createTestDb();
    await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'A due secret',
      scheduledFor: 500,
    });
    const dueRead = deferred<void>();
    const releaseDueRead = deferred<void>();
    let allCalls = 0;
    const fakeDb: AppDatabase = Object.create(db);
    fakeDb.all = ((...args: Parameters<AppDatabase['all']>) => {
      allCalls += 1;
      const result = db.all(...args);
      // Call 1 is the mandatory recovery UPDATE. Park the due-list SELECT after recovery so this
      // test still targets the account switch at its original seam.
      if (allCalls === 2) {
        dueRead.resolve(undefined);
        return releaseDueRead.promise.then(() => result);
      }
      return result;
    }) as AppDatabase['all'];
    (getDatabase as jest.Mock).mockReturnValue(fakeDb);

    const pending = fireDueScheduled(1_000);
    await dueRead.promise;
    const drain = pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    releaseDueRead.resolve(undefined);

    await expect(pending).resolves.toBe(0);
    await drain;
    expect(mockSendTextMessage).not.toHaveBeenCalled();
  });

  it('does not re-arm A’s interrupted row when recovery loses ownership in the DB queue', async () => {
    const { db } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'A interrupted send',
      scheduledFor: 500,
    });
    await claimScheduled(db, id);

    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
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

    const recovery = recoverStuckScheduled();
    await Promise.resolve();
    const drain = pauseRealtimeDeliveries();
    releaseNeighbour();

    await expect(neighbour).rejects.toThrow('neighbour rollback');
    await expect(recovery).resolves.toBe(0);
    await drain;
    expect(await getScheduledById(db, id)).toMatchObject({ status: 'sending' });
  });

  it('does not delete a local row when A’s server cancel completes after B', async () => {
    const { db } = await createTestDb();
    await seedChat(db);
    (getDatabase as jest.Mock).mockReturnValue(db);
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'keep local handle',
      scheduledFor: 9_000_000,
      serverId: 'srv-a',
    });
    const response = deferred<unknown>();
    mockDeleteScheduled.mockReturnValue(response.promise);

    const pending = cancelScheduled({ id, serverId: 'srv-a' });
    await waitUntil(() => mockDeleteScheduled.mock.calls.length === 1);
    const rejected = expect(pending).rejects.toThrow('account session changed');
    const drain = pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    response.resolve(undefined);

    await rejected;
    await drain;
    expect(await getScheduledById(db, id)).not.toBeNull();
  });

  it('keeps the local row when the server refuses its cancellation', async () => {
    const { db } = await createTestDb();
    await seedChat(db);
    (getDatabase as jest.Mock).mockReturnValue(db);
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'retry cancellation later',
      scheduledFor: 9_000_000,
      serverId: 'srv-a',
    });
    mockDeleteScheduled.mockRejectedValue(new Error('server delete failed'));

    await expect(cancelScheduled({ id, serverId: 'srv-a' })).rejects.toThrow(
      'server delete failed',
    );

    expect(await getScheduledById(db, id)).toMatchObject({ id, serverId: 'srv-a' });
  });

  it('rolls back the local delete when account A retires after its server cancel succeeds', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db);
    (getDatabase as jest.Mock).mockReturnValue(db);
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'server gone, local handle retained',
      scheduledFor: 9_000_000,
      serverId: 'srv-a',
    });
    let serverDeleteCompleted = false;
    mockDeleteScheduled.mockImplementation(async () => {
      serverDeleteCompleted = true;
    });

    let drain: Promise<void> | undefined;
    let triggerRan = false;
    let serverWasDeletedFirst = false;
    raw.function('pause_scheduled_cancel_during_delete', () => {
      triggerRan = true;
      serverWasDeletedFirst = serverDeleteCompleted;
      drain = pauseRealtimeDeliveries();
      return 0;
    });
    raw.exec(`
      CREATE TRIGGER pause_scheduled_cancel_during_delete
      AFTER DELETE ON scheduled_messages
      WHEN OLD.id = ${id}
      BEGIN
        SELECT pause_scheduled_cancel_during_delete();
      END
    `);

    const action = cancelScheduled({ id, serverId: 'srv-a' });
    try {
      await expect(action).rejects.toThrow('account session changed');
      if (!drain) throw new Error('scheduled cancel did not revoke the account lease');
      await drain;
    } finally {
      resumeRealtimeDeliveries();
    }

    expect(mockDeleteScheduled).toHaveBeenCalledWith({}, 'srv-a');
    expect(triggerRan).toBe(true);
    expect(serverWasDeletedFirst).toBe(true);
    expect(await getScheduledById(db, id)).toMatchObject({ id, serverId: 'srv-a' });
  });

  it('does not repoint a row from A’s late edit-create response after B', async () => {
    const { db } = await createTestDb();
    await seedChat(db);
    (getDatabase as jest.Mock).mockReturnValue(db);
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'old text',
      scheduledFor: 9_000_000,
      serverId: 'srv-old',
    });
    mockDeleteScheduled.mockResolvedValue(undefined);
    const response = deferred<ReturnType<typeof serverItem>>();
    mockCreateScheduled.mockReturnValue(response.promise);

    const pending = editScheduled(id, { text: 'new text', scheduledFor: 9_500_000 });
    await waitUntil(() => mockCreateScheduled.mock.calls.length === 1);
    const rejected = expect(pending).rejects.toThrow('account session changed');
    const drain = pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    response.resolve(serverItem('srv-new', 'new text'));

    await rejected;
    await drain;
    expect(await getScheduledById(db, id)).toMatchObject({
      text: 'old text',
      scheduledFor: 9_000_000,
      serverId: 'srv-old',
    });
  });

  it('rolls back an edit when A retires inside the local owner after server replacement', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db);
    (getDatabase as jest.Mock).mockReturnValue(db);
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'old text',
      scheduledFor: 9_000_000,
      serverId: 'srv-old',
    });
    const networkTransactionStates: boolean[] = [];
    mockDeleteScheduled.mockImplementation(async () => {
      networkTransactionStates.push(raw.inTransaction);
    });
    mockCreateScheduled.mockImplementation(async () => {
      networkTransactionStates.push(raw.inTransaction);
      return serverItem('srv-new', 'new text');
    });

    let drain: Promise<void> | undefined;
    raw.function('retire_schedule_during_update', () => {
      drain = pauseRealtimeDeliveries();
      return 0;
    });
    raw.exec(`
      CREATE TRIGGER retire_schedule_during_update
      AFTER UPDATE ON scheduled_messages
      WHEN OLD.id = ${id}
      BEGIN
        SELECT retire_schedule_during_update();
      END
    `);

    const action = editScheduled(id, { text: 'new text', scheduledFor: 9_500_000 });
    try {
      await expect(action).rejects.toThrow('account session changed');
      if (!drain) throw new Error('scheduled edit did not revoke the account lease');
      await drain;
    } finally {
      resumeRealtimeDeliveries();
    }

    expect(networkTransactionStates).toEqual([false, false]);
    expect(raw.inTransaction).toBe(false);
    expect(await getScheduledById(db, id)).toMatchObject({
      text: 'old text',
      scheduledFor: 9_000_000,
      serverId: 'srv-old',
    });
  });
});
