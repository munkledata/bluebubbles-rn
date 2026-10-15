/**
 * Folder search: the full-text match over message bodies is the expensive part (it walks every
 * matching message in every chat). It must run before the folder page takes the process-wide write
 * lock, so a long search never stalls sends and sync (review M060). Membership and counts are
 * still read as one consistent snapshot inside the transaction.
 */
import type Database from 'better-sqlite3';
import { Chat, Message } from '@core/models';
import { upsertChats, upsertHandles, upsertMessages } from '@db/repositories';
import type { AppDatabase } from '@db/types';

let mockDb: AppDatabase;
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: jest.fn(async () => mockDb) }));

// eslint-disable-next-line import/first
import { loadCustomFolderInboxPage } from '@/services/customFolderCommands';
// eslint-disable-next-line import/first
import {
  captureRealtimeDeliveryLease,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
// eslint-disable-next-line import/first
import { holdRollingBackDbNeighbour } from '../support/dbOwnershipProof';
// eslint-disable-next-line import/first
import { createTestDb } from '../support/testDb';
// eslint-disable-next-line import/first
import { createCustomFolder, replaceCustomFolderMembership } from '../support/repositoryWrappers';

const CHAT_GUID = 'iMessage;-;folder-search@example.test';

async function seedFolderChat(db: AppDatabase): Promise<number> {
  const handles = await upsertHandles(db, [{ address: 'folder-search@example.test' }]);
  const chatIds = await upsertChats(
    db,
    [
      Chat.parse({
        guid: CHAT_GUID,
        style: 45,
        participants: [{ address: 'folder-search@example.test' }],
      }),
    ],
    handles,
  );
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: 'folder-search-message',
        text: 'the needle is in this message',
        dateCreated: 10,
        originalROWID: 10,
        isFromMe: false,
        handle: { address: 'folder-search@example.test' },
      }),
    ],
    () => chatIds.get(CHAT_GUID)!,
    handles,
  );
  const folder = await createCustomFolder(db, 'Search folder');
  await replaceCustomFolderMembership(db, folder.id, [CHAT_GUID]);
  return folder.id;
}

beforeEach(() => {
  resumeRealtimeDeliveries();
});

it('matches message text before taking the write lock', async () => {
  const { db, raw } = await createTestDb();
  mockDb = db;
  const folderId = await seedFolderChat(db);
  const prepared: string[] = [];
  const prepare = raw.prepare.bind(raw);
  const spy = jest.spyOn(raw, 'prepare').mockImplementation(((source: string) => {
    prepared.push(source);
    return prepare(source);
  }) as Database.Database['prepare']);
  const neighbour = holdRollingBackDbNeighbour(db, () => undefined);
  let page: ReturnType<typeof loadCustomFolderInboxPage> | undefined;
  try {
    await neighbour.entered;
    page = loadCustomFolderInboxPage(folderId, 10, 'needle', captureRealtimeDeliveryLease());
    for (let turn = 0; turn < 20; turn += 1)
      await new Promise<void>((resolve) => setImmediate(resolve));

    // The lock is still held by the neighbour, yet the full-text match has already run.
    expect(prepared.some((statement) => statement.includes('messages_fts MATCH'))).toBe(true);

    neighbour.release();
    await expect(page).resolves.toMatchObject({
      status: 'committed',
      value: { matchingCount: 1, rows: [expect.objectContaining({ guid: CHAT_GUID })] },
    });
  } finally {
    spy.mockRestore();
    await neighbour.cleanup();
    // The queued page must finish before the connection closes underneath it.
    await page?.catch(() => undefined);
    raw.close();
  }
});
