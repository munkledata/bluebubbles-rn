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
let mockServerRcsEnabled = true;
let mockRcsProviderEpoch: string | null;
let mockImessageNewChatEnabled = false;
const mockPrivateApiEnabled = jest.fn(() => true);

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
    getState: () => ({ sendReadReceipts: true, hydrated: true }),
  },
}));
jest.mock('@state/sessionStore', () => ({
  sessionAccessors: {
    privateApiEnabled: () => mockPrivateApiEnabled(),
    rcsEnabled: () => mockServerRcsEnabled,
    rcsProviderEpoch: () => mockRcsProviderEpoch,
    rcsSendAttemptOwnershipSupported: () => true,
    imessageNewChatEnabled: () => mockImessageNewChatEnabled,
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

const RCS_EPOCH_A = `gpe1_${'A'.repeat(43)}`;
const RCS_EPOCH_B = `gpe1_${'B'.repeat(42)}A`;
const encoded = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');
const rcsChatGuid = (epoch: string, source = 'old@example.com'): string =>
  `RCS;-;g1.${epoch}.${encoded(source)}`;

const serverChat = (): Chat =>
  Chat.parse({
    guid: rcsChatGuid(RCS_EPOCH_A),
    providerEpoch: RCS_EPOCH_A,
    participants: [{ address: 'old@example.com', service: 'RCS' }],
  });

const count = (raw: Database.Database, table: 'handles' | 'chats'): number =>
  (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('createNewChat account lease', () => {
  let raw: Database.Database;

  beforeEach(async () => {
    resumeRealtimeDeliveries();
    ({ db: mockDb, raw } = await createTestDb());
    mockServerRcsEnabled = true;
    mockRcsProviderEpoch = RCS_EPOCH_A;
    mockImessageNewChatEnabled = false;
    mockPrivateApiEnabled.mockClear();
    mockEnsureDatabase.mockReset().mockImplementation(() => Promise.resolve(mockDb));
    mockCreateChat.mockReset().mockResolvedValue(serverChat());
  });

  afterEach(() => {
    resumeRealtimeDeliveries();
    jest.restoreAllMocks();
    raw.close();
  });

  it('creates only through the RCS contract and commits the returned chat atomically', async () => {
    await expect(createNewChat(['old@example.com'], 'hello')).resolves.toBe(
      rcsChatGuid(RCS_EPOCH_A),
    );

    expect(mockCreateChat).toHaveBeenCalledTimes(1);
    expect(mockCreateChat).toHaveBeenCalledWith(
      { account: 'captured-by-http-client' },
      {
        address: 'old@example.com',
        message: 'hello',
        service: 'RCS',
        tempGuid: undefined,
        providerEpoch: RCS_EPOCH_A,
      },
    );
    expect(mockPrivateApiEnabled).not.toHaveBeenCalled();
    expect(count(raw, 'handles')).toBe(1);
    expect(count(raw, 'chats')).toBe(1);
  });

  it('sends a plain RCS retry id as its first attempt and requires the server receipt', async () => {
    // Without the id, a create that timed out after Google delivered the first message could only
    // be retried as a brand-new send, so the contact received it twice.
    await expect(
      createNewChat(['old@example.com'], 'hello', undefined, 'RCS', 'temp-plain-rcs'),
    ).resolves.toBe(rcsChatGuid(RCS_EPOCH_A));

    expect(mockCreateChat).toHaveBeenCalledWith(
      { account: 'captured-by-http-client' },
      {
        address: 'old@example.com',
        message: 'hello',
        service: 'RCS',
        tempGuid: 'temp-plain-rcs',
        clientAttemptGeneration: 1,
        requireAttemptReceipt: true,
        providerEpoch: RCS_EPOCH_A,
      },
    );
  });

  it('rejects multiple recipients before DB or HTTP instead of silently dropping one', async () => {
    const invalidAddresses = ['first@example.com', 'second@example.com'] as unknown as [string];
    await expect(createNewChat(invalidAddresses, 'hello')).rejects.toThrow(
      'requires exactly one recipient',
    );

    expect(mockEnsureDatabase).not.toHaveBeenCalled();
    expect(mockCreateChat).not.toHaveBeenCalled();
  });

  it('rejects an expired SHARE new-chat plan before DB or HTTP', async () => {
    const nativeCreatedAtMs = Date.now() - chatRepositories.SHARE_INTAKE_NEW_CHAT_RETRY_WINDOW_MS;
    const tempGuid = 'share-1700000000000-1-0123456789abcdef';

    await expect(
      createNewChat(['old@example.com'], 'hello', undefined, 'RCS', tempGuid, {
        identity: {
          batchId: '1700000000000-1-0123456789abcdef',
          nativeCreatedAtMs,
          hasText: true,
          fileCount: 0,
        },
        plan: {
          address: 'old@example.com',
          body: 'hello',
          service: 'RCS',
          providerEpoch: RCS_EPOCH_A,
          tempGuid,
          clientAttemptGeneration: 1,
        },
      }),
    ).rejects.toThrow('too old to retry safely');

    expect(mockEnsureDatabase).not.toHaveBeenCalled();
    expect(mockCreateChat).not.toHaveBeenCalled();
  });

  it('rejects SHARE-created iMessage chats before DB or HTTP', async () => {
    mockImessageNewChatEnabled = true;
    const tempGuid = 'share-1700000000000-1-fedcba9876543210';

    await expect(
      createNewChat(['+15551234567'], 'hello', undefined, 'iMessage', tempGuid, {
        identity: {
          batchId: '1700000000000-1-fedcba9876543210',
          nativeCreatedAtMs: Date.now(),
          hasText: true,
          fileCount: 0,
        },
        plan: {
          address: '+15551234567',
          body: 'hello',
          service: 'iMessage',
          providerEpoch: null,
          tempGuid,
          clientAttemptGeneration: 1,
        },
      }),
    ).rejects.toThrow('active Messages account');

    expect(mockEnsureDatabase).not.toHaveBeenCalled();
    expect(mockCreateChat).not.toHaveBeenCalled();
  });

  it('creates an RCS chat without consulting an injected legacy Private API flag', async () => {
    mockCreateChat.mockResolvedValueOnce(
      Chat.parse({
        guid: rcsChatGuid(RCS_EPOCH_A, '+15551234567'),
        providerEpoch: RCS_EPOCH_A,
        participants: [{ address: '+15551234567', service: 'RCS' }],
      }),
    );

    await expect(createNewChat(['+15551234567'], 'hello')).resolves.toBe(
      rcsChatGuid(RCS_EPOCH_A, '+15551234567'),
    );
    expect(mockCreateChat).toHaveBeenCalledWith(
      { account: 'captured-by-http-client' },
      {
        address: '+15551234567',
        message: 'hello',
        service: 'RCS',
        tempGuid: undefined,
        providerEpoch: RCS_EPOCH_A,
      },
    );
    expect(mockPrivateApiEnabled).not.toHaveBeenCalled();
  });

  it('rejects RCS creation before DB or HTTP when the RCS bridge is unavailable', async () => {
    mockServerRcsEnabled = false;
    mockRcsProviderEpoch = null;

    await expect(createNewChat(['+15551234567'], 'hello')).rejects.toThrow(
      'RCS conversation is unavailable',
    );
    expect(mockEnsureDatabase).not.toHaveBeenCalled();
    expect(mockCreateChat).not.toHaveBeenCalled();
  });

  it('creates iMessage only under its narrow live capability and preserves the retry id', async () => {
    mockServerRcsEnabled = false;
    mockImessageNewChatEnabled = true;
    mockCreateChat.mockResolvedValueOnce(
      Chat.parse({
        guid: 'iMessage;-;+15551234567',
        participants: [{ address: '+15551234567', service: 'iMessage' }],
      }),
    );

    await expect(
      createNewChat(['+15551234567'], 'hello', undefined, 'iMessage', 'temp-stable-1'),
    ).resolves.toBe('iMessage;-;+15551234567');
    expect(mockCreateChat).toHaveBeenCalledWith(
      { account: 'captured-by-http-client' },
      {
        address: '+15551234567',
        message: 'hello',
        service: 'iMessage',
        tempGuid: 'temp-stable-1',
      },
    );
    expect(count(raw, 'handles')).toBe(1);
    expect(count(raw, 'chats')).toBe(1);
  });

  it('rejects iMessage creation before DB or HTTP when its narrow capability is absent', async () => {
    await expect(
      createNewChat(['+15551234567'], 'hello', undefined, 'iMessage', 'temp-stable-1'),
    ).rejects.toThrow('iMessage conversation is unavailable');
    expect(mockEnsureDatabase).not.toHaveBeenCalled();
    expect(mockCreateChat).not.toHaveBeenCalled();
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

  it('rechecks capability after database setup before starting HTTP', async () => {
    const database = deferred<AppDatabase>();
    mockEnsureDatabase.mockReturnValueOnce(database.promise);
    const create = createNewChat(['old@example.com'], 'hello');
    expect(mockEnsureDatabase).toHaveBeenCalledTimes(1);

    mockServerRcsEnabled = false;
    mockRcsProviderEpoch = null;
    database.resolve(mockDb);

    await expect(create).rejects.toThrow('RCS conversation is unavailable');
    expect(mockCreateChat).not.toHaveBeenCalled();
  });

  it('does not start HTTP after the same session rotates to another RCS provider epoch', async () => {
    const database = deferred<AppDatabase>();
    mockEnsureDatabase.mockReturnValueOnce(database.promise);
    const create = createNewChat(['old@example.com'], 'hello');
    expect(mockEnsureDatabase).toHaveBeenCalledTimes(1);

    mockRcsProviderEpoch = RCS_EPOCH_B;
    database.resolve(mockDb);

    await expect(create).rejects.toThrow('Google pairing');
    expect(mockCreateChat).not.toHaveBeenCalled();
    expect(count(raw, 'handles')).toBe(0);
    expect(count(raw, 'chats')).toBe(0);
  });

  it('disowns an RCS response when the same session rotates epochs before local persistence', async () => {
    const response = deferred<Chat>();
    mockCreateChat.mockReturnValueOnce(response.promise);
    const create = createNewChat(['old@example.com'], 'hello');
    await Promise.resolve();
    await Promise.resolve();
    expect(mockCreateChat).toHaveBeenCalledWith(
      { account: 'captured-by-http-client' },
      expect.objectContaining({ providerEpoch: RCS_EPOCH_A }),
    );

    mockRcsProviderEpoch = RCS_EPOCH_B;
    response.resolve(serverChat());

    await expect(create).rejects.toThrow('Google pairing');
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

describe('createNewChat into a conversation this device already has', () => {
  let raw: Database.Database;

  beforeEach(async () => {
    resumeRealtimeDeliveries();
    ({ db: mockDb, raw } = await createTestDb());
    mockServerRcsEnabled = true;
    mockRcsProviderEpoch = RCS_EPOCH_A;
    mockImessageNewChatEnabled = false;
    mockEnsureDatabase.mockReset().mockImplementation(() => Promise.resolve(mockDb));
    mockCreateChat.mockReset();
  });

  afterEach(() => {
    resumeRealtimeDeliveries();
    jest.restoreAllMocks();
    raw.close();
  });

  const chatRow = (guid: string): unknown =>
    raw
      .prepare(
        `SELECT display_name AS displayName, chat_identifier AS chatIdentifier, style,
                deleted_at AS deletedAt
           FROM chats WHERE guid = ?`,
      )
      .get(guid);

  const memberAddresses = (guid: string): string[] =>
    (
      raw
        .prepare(
          `SELECT h.address AS address
             FROM chat_handles ch
             JOIN handles h ON h.id = ch.handle_id
             JOIN chats c ON c.id = ch.chat_id
            WHERE c.guid = ?
            ORDER BY h.address`,
        )
        .all(guid) as { address: string }[]
    ).map((row) => row.address);

  async function seedExisting(chat: Chat): Promise<void> {
    const handles = await chatRepositories.upsertHandles(mockDb, chat.participants ?? []);
    await chatRepositories.upsertChats(mockDb, [chat], handles);
  }

  it('keeps a named RCS chat intact when the create reply carries only its GUID', async () => {
    const guid = rcsChatGuid(RCS_EPOCH_A);
    await seedExisting(
      Chat.parse({
        guid,
        providerEpoch: RCS_EPOCH_A,
        displayName: 'Pat Example',
        chatIdentifier: 'Pat Example',
        style: 45,
        participants: [{ address: 'Pat Example', service: 'RCS' }],
      }),
    );
    // chatsApi.createChat turns a GUID-only acknowledgement into this provisional shape.
    mockCreateChat.mockResolvedValueOnce(
      Chat.parse({ guid, participants: [{ address: 'old@example.com', service: 'RCS' }] }),
    );

    await expect(createNewChat(['old@example.com'], 'hello')).resolves.toBe(guid);

    expect(chatRow(guid)).toEqual({
      displayName: 'Pat Example',
      chatIdentifier: 'Pat Example',
      style: 45,
      deletedAt: null,
    });
    expect(memberAddresses(guid)).toEqual(['Pat Example']);
  });

  it('keeps a proven one-to-one iMessage chat intact and still un-deletes it', async () => {
    mockServerRcsEnabled = false;
    mockImessageNewChatEnabled = true;
    const guid = 'any;-;+15551234567';
    await seedExisting(
      Chat.parse({
        guid,
        chatIdentifier: '+15551234567',
        style: 45,
        participants: [{ address: '+15551234567', service: 'iMessage' }],
      }),
    );
    raw.prepare('UPDATE chats SET deleted_at = 1000 WHERE guid = ?').run(guid);
    mockCreateChat.mockResolvedValueOnce(
      Chat.parse({ guid, participants: [{ address: '+15551234567', service: 'iMessage' }] }),
    );

    await expect(
      createNewChat(['+15551234567'], 'hello', undefined, 'iMessage', 'temp-existing-1'),
    ).resolves.toBe(guid);

    // Style 45 is what proves a one-to-one iMessage chat; losing it drops the exact send path.
    expect(chatRow(guid)).toEqual({
      displayName: null,
      chatIdentifier: '+15551234567',
      style: 45,
      deletedAt: null,
    });
    expect(memberAddresses(guid)).toEqual(['+15551234567']);
  });
});
