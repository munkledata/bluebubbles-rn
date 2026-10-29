/**
 * findOrCreateRcsChat: Google's get-or-create for one address with no message sent. The full chat
 * the server returns is saved only when it is new here; an existing conversation stays as sync
 * left it, and choosing the person again un-deletes it.
 */
import type Database from 'better-sqlite3';
import { chatsApi } from '@core/api';
import { Chat } from '@core/models';
import * as chatRepositories from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { findOrCreateRcsChat } from '@/services/chatActions';
import { ensureDatabase } from '@/services/databaseControl';
import { resumeRealtimeDeliveries } from '@/services/realtime/deliveryCoordinator';
import { createTestDb } from '../support/testDb';

let mockDb: AppDatabase;
let mockRcsProviderEpoch: string | null;
let mockFindSupported = true;

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
    privateApiEnabled: () => false,
    rcsEnabled: () => true,
    rcsProviderEpoch: () => mockRcsProviderEpoch,
    rcsSendAttemptOwnershipSupported: () => true,
    rcsFindOrCreateChatSupported: () => mockFindSupported,
    imessageNewChatEnabled: () => false,
  },
}));
jest.mock('@core/api', () => ({
  chatsApi: { findOrCreateRcsChat: jest.fn(), createChat: jest.fn() },
  scheduledApi: {},
}));

const mockFind = chatsApi.findOrCreateRcsChat as jest.Mock;
const mockCreateChat = chatsApi.createChat as jest.Mock;
const mockEnsureDatabase = ensureDatabase as jest.Mock;

const RCS_EPOCH_A = `gpe1_${'A'.repeat(43)}`;
const RCS_EPOCH_B = `gpe1_${'B'.repeat(42)}A`;
const encoded = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');
const rcsChatGuid = (epoch: string, source = 'conv-1'): string =>
  `RCS;-;g1.${epoch}.${encoded(source)}`;

const foundChat = (epoch = RCS_EPOCH_A): Chat =>
  Chat.parse({
    guid: rcsChatGuid(epoch),
    providerEpoch: epoch,
    chatIdentifier: '+15557654321',
    displayName: 'Ada',
    style: 45,
    participants: [{ address: '+15557654321', service: 'RCS' }],
  });

describe('findOrCreateRcsChat', () => {
  let raw: Database.Database;

  const chatRow = (guid: string): unknown =>
    raw
      .prepare(
        `SELECT display_name AS displayName, chat_identifier AS chatIdentifier, style,
                deleted_at AS deletedAt
           FROM chats WHERE guid = ?`,
      )
      .get(guid);
  const chatCount = (): number =>
    (raw.prepare('SELECT COUNT(*) AS n FROM chats').get() as { n: number }).n;

  beforeEach(async () => {
    resumeRealtimeDeliveries();
    ({ db: mockDb, raw } = await createTestDb());
    mockRcsProviderEpoch = RCS_EPOCH_A;
    mockFindSupported = true;
    mockEnsureDatabase.mockReset().mockImplementation(() => Promise.resolve(mockDb));
    mockFind.mockReset().mockResolvedValue(foundChat());
    mockCreateChat.mockReset();
  });

  afterEach(() => {
    resumeRealtimeDeliveries();
    jest.restoreAllMocks();
    raw.close();
  });

  it('asks for the chat with the current pairing, sends nothing, and saves a new chat in full', async () => {
    await expect(findOrCreateRcsChat('+15557654321')).resolves.toBe(rcsChatGuid(RCS_EPOCH_A));

    expect(mockFind).toHaveBeenCalledWith(
      { account: 'captured-by-http-client' },
      '+15557654321',
      RCS_EPOCH_A,
    );
    expect(mockCreateChat).not.toHaveBeenCalled();
    expect(chatRow(rcsChatGuid(RCS_EPOCH_A))).toEqual({
      displayName: 'Ada',
      chatIdentifier: '+15557654321',
      style: 45,
      deletedAt: null,
    });
  });

  it('keeps a chat this device already has as it is, and un-deletes it', async () => {
    const guid = rcsChatGuid(RCS_EPOCH_A);
    const existing = Chat.parse({
      guid,
      providerEpoch: RCS_EPOCH_A,
      chatIdentifier: 'Ada Lovelace',
      displayName: 'Ada Lovelace',
      style: 45,
      participants: [{ address: 'Ada Lovelace', service: 'RCS' }],
    });
    const handles = await chatRepositories.upsertHandles(mockDb, existing.participants ?? []);
    await chatRepositories.upsertChats(mockDb, [existing], handles);
    raw.prepare('UPDATE chats SET deleted_at = 1000 WHERE guid = ?').run(guid);

    await expect(findOrCreateRcsChat('+15557654321')).resolves.toBe(guid);

    expect(chatRow(guid)).toEqual({
      displayName: 'Ada Lovelace',
      chatIdentifier: 'Ada Lovelace',
      style: 45,
      deletedAt: null,
    });
  });

  it('refuses before DB or HTTP when the server lacks the step or Google is not paired', async () => {
    mockFindSupported = false;
    await expect(findOrCreateRcsChat('+15557654321')).rejects.toThrow('unavailable');
    mockFindSupported = true;
    mockRcsProviderEpoch = null;
    await expect(findOrCreateRcsChat('+15557654321')).rejects.toThrow('Google pairing');
    mockRcsProviderEpoch = RCS_EPOCH_A;
    await expect(findOrCreateRcsChat('  ')).rejects.toThrow('recipient');

    expect(mockEnsureDatabase).not.toHaveBeenCalled();
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('saves nothing when Google is re-paired while the request is out', async () => {
    let resolve!: (chat: Chat) => void;
    mockFind.mockReturnValueOnce(
      new Promise<Chat>((done) => {
        resolve = done;
      }),
    );
    const pending = findOrCreateRcsChat('+15557654321');
    await Promise.resolve();
    await Promise.resolve();
    expect(mockFind).toHaveBeenCalledTimes(1);

    mockRcsProviderEpoch = RCS_EPOCH_B;
    resolve(foundChat());

    await expect(pending).rejects.toThrow('Google pairing');
    expect(chatCount()).toBe(0);
  });

  it('refuses a reply from another pairing', async () => {
    mockFind.mockResolvedValueOnce(foundChat(RCS_EPOCH_B));

    await expect(findOrCreateRcsChat('+15557654321')).rejects.toThrow('different Google pairing');
    expect(chatCount()).toBe(0);
  });
});
