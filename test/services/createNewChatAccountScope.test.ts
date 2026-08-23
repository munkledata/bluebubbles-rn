/**
 * Account-bound create-chat orchestration.
 *
 * The server POST is intentionally long-lived and cannot be recalled once the old server accepts
 * it. These tests pin the boundary we can enforce: an A operation never starts a request after B
 * connects, never reconciles an old response into B's database, and rolls back a local transaction
 * when Disconnect lands between its statements.
 */
import type Database from 'better-sqlite3';
import { chatsApi } from '@core/api';
import { Chat } from '@core/models';
import * as chatRepositories from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createNewChat } from '@/services/chatActions';
import { ensureDatabase } from '@/services/databaseControl';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { createTestDb } from '../support/testDb';

let mockDb: AppDatabase;

jest.mock('@db/repositories', () => {
  const actual = jest.requireActual<typeof import('@db/repositories')>('@db/repositories');
  return {
    ...actual,
    upsertHandlesWithinTransaction: jest.fn(actual.upsertHandlesWithinTransaction),
  };
});
jest.mock('@/services/clients', () => ({ http: { account: 'captured-by-http-client' } }));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: jest.fn(() => mockDb) }));
jest.mock('@/services/realtimeControl', () => ({ getSocket: jest.fn(() => null) }));
jest.mock('@state/featureSettingsStore', () => ({
  useFeatureSettingsStore: {
    getState: () => ({ privateApiEnabled: true, sendReadReceipts: true, hydrated: true }),
  },
}));
jest.mock('@core/api', () => ({
  chatsApi: { createChat: jest.fn() },
  scheduledApi: {},
}));

const mockCreateChat = chatsApi.createChat as jest.Mock;
const mockEnsureDatabase = ensureDatabase as jest.Mock;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const serverChat = (): Chat =>
  Chat.parse({
    guid: 'iMessage;-;old@example.com',
    participants: [{ address: 'old@example.com', service: 'iMessage' }],
  });

const count = (raw: Database.Database, table: 'handles' | 'chats'): number =>
  (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('createNewChat account lease', () => {
  let raw: Database.Database;

  beforeEach(async () => {
    resumeRealtimeDeliveries();
    ({ db: mockDb, raw } = await createTestDb());
    mockEnsureDatabase.mockReset().mockImplementation(() => Promise.resolve(mockDb));
    mockCreateChat.mockReset().mockResolvedValue(serverChat());
  });

  afterEach(() => {
    resumeRealtimeDeliveries();
    jest.restoreAllMocks();
    raw.close();
  });

  it('preserves the ordinary create path and commits the returned chat atomically', async () => {
    await expect(createNewChat(['old@example.com'], 'hello')).resolves.toBe(
      'iMessage;-;old@example.com',
    );

    expect(mockCreateChat).toHaveBeenCalledTimes(1);
    expect(count(raw, 'handles')).toBe(1);
    expect(count(raw, 'chats')).toBe(1);
  });

  it('links the created participant to a device contact after the chat commit', async () => {
    await chatRepositories.upsertContacts(mockDb, [
      {
        sourceId: 'create-contact',
        displayName: 'Local Name',
        givenName: 'Local',
        familyName: 'Name',
        phones: [],
        emails: ['old@example.com'],
        avatar: null,
      },
    ]);

    await createNewChat(['old@example.com'], 'hello');

    expect(
      raw
        .prepare(
          `SELECT h.display_name AS displayName, c.source_id AS sourceId
             FROM handles h
             JOIN contacts c ON c.id = h.contact_id
            WHERE h.address = 'old@example.com'`,
        )
        .get(),
    ).toEqual({ displayName: 'Local Name', sourceId: 'create-contact' });
  });

  it('does not start a B-credential request when an A call wakes after database setup', async () => {
    const database = deferred<AppDatabase>();
    mockEnsureDatabase.mockReturnValueOnce(database.promise);
    const oldCreate = createNewChat(['old@example.com'], 'old account message');
    expect(mockEnsureDatabase).toHaveBeenCalledTimes(1);

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    database.resolve(mockDb);

    await expect(oldCreate).rejects.toThrow('account session changed');
    expect(mockCreateChat).not.toHaveBeenCalled();
    expect(count(raw, 'handles')).toBe(0);
    expect(count(raw, 'chats')).toBe(0);
  });

  it('disowns an accepted A-server response instead of reconciling it into B', async () => {
    const response = deferred<Chat>();
    mockCreateChat.mockReturnValueOnce(response.promise);
    const oldCreate = createNewChat(['old@example.com'], 'old account message');
    await Promise.resolve();
    await Promise.resolve();
    expect(mockCreateChat).toHaveBeenCalledTimes(1);

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    response.resolve(serverChat());

    await expect(oldCreate).rejects.toThrow('account session changed');
    expect(mockCreateChat).toHaveBeenCalledTimes(1);
    expect(count(raw, 'handles')).toBe(0);
    expect(count(raw, 'chats')).toBe(0);
  });

  it('rolls back a local reconcile when Disconnect lands between its DB statements', async () => {
    const handleWriteFinished = deferred<void>();
    const releaseHandleCall = deferred<void>();
    const realUpsertHandlesWithinTransaction =
      jest.requireActual<typeof import('@db/repositories')>(
        '@db/repositories',
      ).upsertHandlesWithinTransaction;
    const mockUpsertHandlesWithinTransaction =
      chatRepositories.upsertHandlesWithinTransaction as jest.MockedFunction<
        typeof chatRepositories.upsertHandlesWithinTransaction
      >;
    mockUpsertHandlesWithinTransaction.mockImplementationOnce(async (...args) => {
      const result = await realUpsertHandlesWithinTransaction(...args);
      handleWriteFinished.resolve();
      await releaseHandleCall.promise;
      return result;
    });

    const oldCreate = createNewChat(['old@example.com'], 'old account message');
    await handleWriteFinished.promise;
    // The handle exists on this connection while the transaction is open.
    expect(count(raw, 'handles')).toBe(1);

    let drainFinished = false;
    const drain = pauseRealtimeDeliveries().then(() => {
      drainFinished = true;
    });
    await Promise.resolve();
    expect(drainFinished).toBe(false);

    releaseHandleCall.resolve();
    await expect(oldCreate).rejects.toThrow('account session changed');
    await drain;
    resumeRealtimeDeliveries();

    expect(count(raw, 'handles')).toBe(0);
    expect(count(raw, 'chats')).toBe(0);
  });
});
