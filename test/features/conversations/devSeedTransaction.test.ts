import type Database from 'better-sqlite3';
import type { AppDatabase } from '@db/types';
import { getDatabase } from '@db/database';
import { upsertMessages } from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { seedFixtures } from '@features/conversations/devSeed';
import { createTestDb } from '../../support/testDb';

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));

// Keep the real read-marker owner: it is the behavior under test. The other seed writers are
// deliberately fast fakes so they cannot queue behind the held neighbour before seedFixtures
// reaches c-work's read marker and make this overlap proof vacuous.
jest.mock('@db/repositories', () => ({
  ...jest.requireActual('@db/repositories'),
  getChatIdByGuid: jest.fn(async () => null),
  upsertHandles: jest.fn(
    async (_db: AppDatabase, handles: { address: string }[]) =>
      new Map(handles.map((handle, index) => [handle.address, index + 1])),
  ),
  upsertChats: jest.fn(
    async (_db: AppDatabase, chats: { guid: string }[]) =>
      new Map(chats.map((chat) => [chat.guid, 1])),
  ),
  upsertMessages: jest.fn(async () => undefined),
}));

jest.mock('@/services/download', () => ({ setAttachmentFetcher: jest.fn() }));
jest.mock('@/services/download/devFetcher', () => ({ devProgressFetcher: jest.fn() }));
jest.mock('@/services/realtimeControl', () => ({
  devPersistRealtimeEventWithoutDrain: jest.fn(),
  devPush: { inject: jest.fn() },
  devResumePersistedRealtimeEvents: jest.fn(),
}));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  runTrackedRealtimeWork: jest.fn((_lease: unknown, write: () => Promise<unknown>) => write()),
}));
jest.mock('@/services/send/sendService', () => ({
  generateTempGuid: jest.fn(() => 'temp-dev-seed-transaction'),
}));
jest.mock('@utils/isDev', () => ({ isDevServer: jest.fn(() => true) }));

const mockGetDatabase = getDatabase as jest.Mock;
const mockUpsertMessages = upsertMessages as jest.Mock;

function marker(raw: Database.Database): {
  lastReadMessageGuid: string | null;
  markedUnreadAt: number | null;
} {
  return raw
    .prepare(
      `SELECT last_read_message_guid AS lastReadMessageGuid,
              marked_unread_at AS markedUnreadAt
         FROM chats
        WHERE guid = 'c-work'`,
    )
    .get() as { lastReadMessageGuid: string | null; markedUnreadAt: number | null };
}

describe('DEV fixture seed — transaction ownership', () => {
  it('queues the read marker behind a rolling-back neighbour, then commits it independently', async () => {
    const { db, raw } = await createTestDb();
    mockGetDatabase.mockReturnValue(db);
    raw
      .prepare(
        `INSERT INTO chats (guid, last_read_message_guid, marked_unread_at)
         VALUES ('c-work', 'before-seed', 777)`,
      )
      .run();

    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbourError = new Error('dev-seed neighbour rollback');
    const neighbour = withDbTransaction(db, async () => {
      raw
        .prepare("UPDATE chats SET last_read_message_guid = 'phantom' WHERE guid = 'c-work'")
        .run();
      neighbourStarted();
      await held;
      throw neighbourError;
    }).catch((error: unknown) => error);
    await started;

    let seedSettled = false;
    const seeded = seedFixtures().finally(() => {
      seedSettled = true;
    });

    // c-work is fixture five. Give every mocked pre-marker await ample time to settle while the
    // real marker owner remains parked on the transaction queue.
    for (let turn = 0; turn < 50 && mockUpsertMessages.mock.calls.length < 5; turn += 1) {
      await Promise.resolve();
    }
    // A missing `await` can advance only one mocked repository call per microtask. Drain well past
    // the remaining five fixtures: the correct owner stays parked at five, while a fire-and-forget
    // marker call reaches ten and settles the seed before the neighbour is released.
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
    const callsWhileHeld = mockUpsertMessages.mock.calls.length;
    const settledWhileHeld = seedSettled;
    const markerWhileHeld = marker(raw);

    releaseNeighbour();
    const [rolledBack, seededCount] = await Promise.all([neighbour, seeded]);
    const markerAfterSeed = marker(raw);

    expect(callsWhileHeld).toBe(5);
    expect(settledWhileHeld).toBe(false);
    expect(markerWhileHeld).toEqual({
      lastReadMessageGuid: 'phantom',
      markedUnreadAt: 777,
    });
    expect(rolledBack).toBe(neighbourError);
    expect(seededCount).toBe(10);
    expect(mockUpsertMessages).toHaveBeenCalledTimes(10);
    expect(markerAfterSeed).toEqual({
      lastReadMessageGuid: 'c-work-m',
      markedUnreadAt: null,
    });
  });
});
