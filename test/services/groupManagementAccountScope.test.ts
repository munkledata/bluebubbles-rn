import type Database from 'better-sqlite3';
import { chatsApi } from '@core/api';
import { Chat } from '@core/models';
import * as chatRepositories from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  clearGroupPhoto,
  leaveGroupChat,
  renameGroupChat,
  setGroupPhoto,
  updateGroupParticipant,
} from '@/services/chat/groupManagement';
import { deleteChat } from '@/services/chatActions';
import { ensureDatabase } from '@/services/databaseControl';
import { removeGroupIcon, uploadGroupIcon } from '@/services/chat/groupIcon';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { createTestDb } from '../support/testDb';

let mockDb: AppDatabase;

jest.mock('@core/api', () => ({
  chatsApi: {
    renameChat: jest.fn(),
    updateParticipant: jest.fn(),
    leaveChat: jest.fn(),
  },
}));
jest.mock('@db/repositories', () => {
  const actual = jest.requireActual<typeof import('@db/repositories')>('@db/repositories');
  return {
    ...actual,
    persistServerChatWithinTransaction: jest.fn(actual.persistServerChatWithinTransaction),
  };
});
jest.mock('@/services/clients', () => ({ http: { account: 'snapshotted-by-http-client' } }));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: jest.fn(() => mockDb) }));
jest.mock('@/services/chatActions', () => ({ deleteChat: jest.fn() }));
jest.mock('@/services/chat/groupIcon', () => ({
  uploadGroupIcon: jest.fn(),
  removeGroupIcon: jest.fn(),
}));

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
    guid: 'iMessage;+;group-old',
    displayName: 'Renamed',
    participants: [
      { address: 'old@example.com', service: 'iMessage' },
      { address: '+15555550123', service: 'iMessage' },
    ],
  });

const count = (raw: Database.Database, table: 'handles' | 'chats'): number =>
  (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('group management account scope', () => {
  let raw: Database.Database;
  const mockRename = chatsApi.renameChat as jest.Mock;
  const mockUpdate = chatsApi.updateParticipant as jest.Mock;
  const mockLeave = chatsApi.leaveChat as jest.Mock;
  const mockPersistWithinTransaction =
    chatRepositories.persistServerChatWithinTransaction as jest.MockedFunction<
      typeof chatRepositories.persistServerChatWithinTransaction
    >;

  beforeEach(async () => {
    resumeRealtimeDeliveries();
    ({ db: mockDb, raw } = await createTestDb());
    (ensureDatabase as jest.Mock).mockReset().mockResolvedValue(mockDb);
    mockRename.mockReset().mockResolvedValue(serverChat());
    mockUpdate.mockReset().mockResolvedValue(serverChat());
    mockLeave.mockReset().mockResolvedValue(undefined);
    mockPersistWithinTransaction
      .mockReset()
      .mockImplementation(
        jest.requireActual<typeof import('@db/repositories')>('@db/repositories')
          .persistServerChatWithinTransaction,
      );
    (deleteChat as jest.Mock).mockReset().mockResolvedValue(undefined);
    (uploadGroupIcon as jest.Mock).mockReset().mockResolvedValue(undefined);
    (removeGroupIcon as jest.Mock).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    resumeRealtimeDeliveries();
    raw.close();
  });

  it('persists an ordinary rename atomically', async () => {
    await expect(renameGroupChat('iMessage;+;group-old', 'Renamed')).resolves.toBe(true);

    expect(mockRename).toHaveBeenCalledTimes(1);
    expect(count(raw, 'handles')).toBe(2);
    expect(count(raw, 'chats')).toBe(1);
  });

  it('does not start a delayed dialog action with the next account credentials', async () => {
    const oldScreenLease = captureRealtimeDeliveryLease();
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();

    await expect(
      updateGroupParticipant('iMessage;+;group-old', 'remove', 'old@example.com', oldScreenLease),
    ).resolves.toBe(false);
    await expect(leaveGroupChat('iMessage;+;group-old', oldScreenLease)).resolves.toBe(false);
    await expect(
      setGroupPhoto(
        'iMessage;+;group-old',
        { uri: 'file:///old.jpg', name: 'old.jpg', mimeType: 'image/jpeg' },
        oldScreenLease,
      ),
    ).resolves.toBe(false);
    await expect(clearGroupPhoto('iMessage;+;group-old', oldScreenLease)).resolves.toBe(false);

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockLeave).not.toHaveBeenCalled();
    expect(uploadGroupIcon).not.toHaveBeenCalled();
    expect(removeGroupIcon).not.toHaveBeenCalled();
  });

  it('disowns an accepted old-account response and holds the Disconnect drain', async () => {
    const response = deferred<Chat>();
    mockRename.mockReturnValueOnce(response.promise);
    const oldRename = renameGroupChat('iMessage;+;group-old', 'Old account name');
    await Promise.resolve();
    expect(mockRename).toHaveBeenCalledTimes(1);

    let drained = false;
    const drain = pauseRealtimeDeliveries().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    response.resolve(serverChat());
    await expect(oldRename).resolves.toBe(false);
    await drain;
    expect(mockPersistWithinTransaction).not.toHaveBeenCalled();
    expect(count(raw, 'handles')).toBe(0);
    expect(count(raw, 'chats')).toBe(0);
  });

  it('rolls back a returned chat when Disconnect lands between its DB statements', async () => {
    const writeFinished = deferred<void>();
    const releaseWrite = deferred<void>();
    const realPersistWithinTransaction =
      jest.requireActual<typeof import('@db/repositories')>(
        '@db/repositories',
      ).persistServerChatWithinTransaction;
    mockPersistWithinTransaction.mockImplementationOnce(async (...args) => {
      await realPersistWithinTransaction(...args);
      writeFinished.resolve();
      await releaseWrite.promise;
    });

    const oldRename = renameGroupChat('iMessage;+;group-old', 'Old account name');
    await writeFinished.promise;
    expect(count(raw, 'handles')).toBe(2);

    let drained = false;
    const drain = pauseRealtimeDeliveries().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseWrite.resolve();
    await expect(oldRename).resolves.toBe(false);
    await drain;
    expect(count(raw, 'handles')).toBe(0);
    expect(count(raw, 'chats')).toBe(0);
  });

  it('queues the standalone repository owner behind a rolling-back neighbour', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const neighbour = withDbTransaction(mockDb, async () => {
      raw
        .prepare(
          `INSERT INTO handles (address, service, display_name)
           VALUES ('phantom@example.com', '', 'Phantom')`,
        )
        .run();
      started.resolve();
      await release.promise;
      throw new Error('neighbour rollback');
    });
    await started.promise;

    const persistence = chatRepositories.persistServerChat(mockDb, serverChat());
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(count(raw, 'chats')).toBe(0);

    release.resolve();
    await expect(neighbour).rejects.toThrow('neighbour rollback');
    await persistence;
    expect(count(raw, 'handles')).toBe(2);
    expect(count(raw, 'chats')).toBe(1);
  });

  it('never runs the local Leave delete after its server response loses ownership', async () => {
    const response = deferred<void>();
    mockLeave.mockReturnValueOnce(response.promise);
    const oldLeave = leaveGroupChat('iMessage;+;group-old');
    await Promise.resolve();

    const drain = pauseRealtimeDeliveries();
    response.resolve();
    await expect(oldLeave).resolves.toBe(false);
    await drain;

    expect(deleteChat).not.toHaveBeenCalled();
  });
});
