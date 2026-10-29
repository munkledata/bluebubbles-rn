/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
/**
 * markAllChatsRead (src/services/chatActions.ts) dismisses the tray's message notifications once
 * the local read markers commit. Locks in:
 *   - the cleanup runs AFTER the markers are cleared, with the lease the action ran under;
 *   - a retired account never reaches the cleanup;
 *   - a failed mark leaves the tray alone;
 *   - a failing cleanup never costs the committed mark.
 * The cleanup itself (which ids it cancels, reminders left alone) is readNotificationCleanup.test.ts.
 */
import { Chat, Message } from '@core/models';
import { getChatIdByGuid, upsertChats, upsertHandles, upsertMessages } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import type Database from 'better-sqlite3';
import { createTestDb } from '../support/testDb';

// Hoisted jest.mock factories may only reference `mock`-prefixed vars.
let mockDb: AppDatabase;
let mockRaw: Database.Database;
const mockClearAll = jest.fn<Promise<void>, [unknown]>();
const mockUnreadAtCleanup: (number | null)[] = [];

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/clients', () => ({ http: { __http: true } }));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: jest.fn(async () => mockDb) }));
jest.mock('@/services/realtimeControl', () => ({ getSocket: jest.fn(() => null) }));
jest.mock('@/services/download/downloadService', () => ({ cancelAttachmentDownloads: jest.fn() }));
jest.mock('@state/featureSettingsStore', () => ({
  useFeatureSettingsStore: {
    getState: () => ({ privateApiEnabled: true, sendReadReceipts: true, hydrated: true }),
  },
}));
jest.mock('@core/api', () => ({ chatsApi: {}, scheduledApi: {} }));
jest.mock('@/services/notifications/readNotificationCleanup', () => ({
  clearAllMessageNotifications: (context: unknown) => {
    const row = mockRaw.prepare('SELECT marked_unread_at AS unreadAt FROM chats').get() as {
      unreadAt: number | null;
    };
    mockUnreadAtCleanup.push(row.unreadAt);
    return mockClearAll(context);
  },
}));
jest.mock('@core/secure', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { logger } from '@core/secure';
import { markAllChatsRead, markUnread } from '@/services/chatActions';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const GUID = 'iMessage;-;+15551234567';

beforeEach(async () => {
  resumeRealtimeDeliveries();
  const t = await createTestDb();
  mockDb = t.db;
  mockRaw = t.raw;
  mockClearAll.mockReset().mockResolvedValue(undefined);
  mockUnreadAtCleanup.length = 0;
  (logger.warn as jest.Mock).mockClear();
  const hm = await upsertHandles(t.db, [{ address: '+15551234567' }]);
  await upsertChats(
    t.db,
    [Chat.parse({ guid: GUID, participants: [{ address: '+15551234567' }] })],
    hm,
  );
  const chatId = (await getChatIdByGuid(t.db, GUID))!;
  await upsertMessages(
    t.db,
    [Message.parse({ guid: 'm1', text: 'hi', isFromMe: false, dateCreated: 1_000 })],
    () => chatId,
    hm,
  );
  await markUnread(GUID);
});

afterEach(() => {
  resumeRealtimeDeliveries();
});

const unreadAt = (): number | null =>
  (
    mockRaw.prepare('SELECT marked_unread_at AS unreadAt FROM chats').get() as {
      unreadAt: number | null;
    }
  ).unreadAt;

describe('markAllChatsRead tray cleanup', () => {
  it('dismisses message notifications only after the read markers commit', async () => {
    expect(unreadAt()).not.toBeNull();
    const lease = captureRealtimeDeliveryLease();

    await markAllChatsRead(lease);

    expect(unreadAt()).toBeNull();
    expect(mockClearAll).toHaveBeenCalledTimes(1);
    // The marker was already cleared when the cleanup ran.
    expect(mockUnreadAtCleanup).toEqual([null]);
    const cleanupLease = mockClearAll.mock.calls[0]?.[0] as { generation: number };
    expect(cleanupLease.generation).toBe(lease.generation);
  });

  it('never clears notifications for a retired account', async () => {
    const lease = captureRealtimeDeliveryLease();
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();

    await markAllChatsRead(lease);

    expect(mockClearAll).not.toHaveBeenCalled();
    expect(unreadAt()).not.toBeNull();
  });

  it('leaves the tray alone when the mark fails', async () => {
    mockRaw.exec('DROP TABLE chats');

    await expect(markAllChatsRead()).rejects.toThrow();

    expect(mockClearAll).not.toHaveBeenCalled();
  });

  it('keeps the committed mark when the cleanup fails', async () => {
    mockClearAll.mockRejectedValue(new Error('native unavailable'));

    await expect(markAllChatsRead()).resolves.toBeUndefined();

    expect(unreadAt()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      '[chats] tray notification cleanup failed after mark all read',
      expect.any(Error),
    );
  });
});
