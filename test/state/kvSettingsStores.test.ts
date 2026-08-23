/**
 * The simple sync-cap setting hydrates from `kv` via `getDatabase()` and MUST survive the DB not
 * being open yet (leave `hydrated` false, no throw — the documented launch-order crash class).
 */
import { getDatabase } from '@db/database';
import { kvGet, kvSet } from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { SYNC_MESSAGES_PER_CHAT_KEY, useSyncSettingsStore } from '@state/syncSettingsStore';
import { createTestDb } from '../support/testDb';

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
const mockGetDatabase = getDatabase as jest.Mock;

/** Point the mocked getDatabase() at a fresh in-memory DB; returns it for seeding. */
async function openTestDb() {
  const t = await createTestDb();
  mockGetDatabase.mockReturnValue(t.db);
  return t.db;
}

function closeDb() {
  mockGetDatabase.mockImplementation(() => {
    throw new Error('Database not initialized');
  });
}

beforeEach(() => {
  useSyncSettingsStore.setState({ messagesPerChat: 0, hydrated: false });
});

describe('hydrate with the DB not open yet (app launch before connect)', () => {
  it('leaves hydrated=false and the default value, without throwing', async () => {
    closeDb();
    await useSyncSettingsStore.getState().hydrate();
    expect(useSyncSettingsStore.getState()).toMatchObject({ messagesPerChat: 0, hydrated: false });
  });
});

describe('syncSettingsStore', () => {
  it('round-trips a cap value', async () => {
    const db = await openTestDb();
    await useSyncSettingsStore.getState().setMessagesPerChat(250);
    expect(await kvGet(db, SYNC_MESSAGES_PER_CHAT_KEY)).toBe('250');
    useSyncSettingsStore.setState({ messagesPerChat: 0, hydrated: false });
    await useSyncSettingsStore.getState().hydrate();
    expect(useSyncSettingsStore.getState()).toMatchObject({ messagesPerChat: 250, hydrated: true });
  });

  it('keeps an optimistic change pending behind a rolling-back neighbour, then persists it exactly', async () => {
    const { db, raw } = await createTestDb();
    const accountB = await createTestDb();
    mockGetDatabase.mockReturnValue(db);
    await kvSet(db, SYNC_MESSAGES_PER_CHAT_KEY, '25');
    await kvSet(accountB.db, SYNC_MESSAGES_PER_CHAT_KEY, '50');

    let markNeighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const neighbourStarted = new Promise<void>((resolve) => {
      markNeighbourStarted = resolve;
    });
    const neighbourHeld = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbourError = new Error('sync settings neighbour rollback');
    const neighbour = withDbTransaction(db, async () => {
      raw
        .prepare('UPDATE kv SET value = ? WHERE key = ?')
        .run('phantom', SYNC_MESSAGES_PER_CHAT_KEY);
      markNeighbourStarted();
      await neighbourHeld;
      throw neighbourError;
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await neighbourStarted;

    let setterSettled = false;
    const setter = useSyncSettingsStore
      .getState()
      .setMessagesPerChat(250)
      .finally(() => {
        setterSettled = true;
      });
    mockGetDatabase.mockReturnValue(accountB.db);

    let observationError: unknown;
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const heldRow = raw
        .prepare('SELECT value FROM kv WHERE key = ?')
        .get(SYNC_MESSAGES_PER_CHAT_KEY) as { value: string } | undefined;
      expect(setterSettled).toBe(false);
      expect(useSyncSettingsStore.getState().messagesPerChat).toBe(250);
      expect(heldRow?.value).toBe('phantom');
    } catch (error) {
      observationError = error;
    } finally {
      releaseNeighbour();
    }

    const [rolledBack] = await Promise.all([neighbour, setter]);
    if (observationError) throw observationError;
    expect(rolledBack).toBe(neighbourError);
    expect(await kvGet(db, SYNC_MESSAGES_PER_CHAT_KEY)).toBe('250');
    expect(await kvGet(accountB.db, SYNC_MESSAGES_PER_CHAT_KEY)).toBe('50');
    expect(useSyncSettingsStore.getState().messagesPerChat).toBe(250);
  });

  it('keeps the optimistic value when persistence rolls back and releases the queue for retry', async () => {
    const { db, raw } = await createTestDb();
    mockGetDatabase.mockReturnValue(db);
    await kvSet(db, SYNC_MESSAGES_PER_CHAT_KEY, '25');
    raw.exec(`
      CREATE TRIGGER reject_sync_messages_per_chat
      BEFORE UPDATE OF value ON kv
      WHEN OLD.key = '${SYNC_MESSAGES_PER_CHAT_KEY}'
      BEGIN
        SELECT RAISE(ABORT, 'SYNC_SETTINGS_RAW_CANARY');
      END
    `);

    await expect(useSyncSettingsStore.getState().setMessagesPerChat(250)).resolves.toBeUndefined();
    expect(useSyncSettingsStore.getState().messagesPerChat).toBe(250);
    expect(await kvGet(db, SYNC_MESSAGES_PER_CHAT_KEY)).toBe('25');

    raw.exec('DROP TRIGGER reject_sync_messages_per_chat');
    await useSyncSettingsStore.getState().setMessagesPerChat(500);
    expect(useSyncSettingsStore.getState().messagesPerChat).toBe(500);
    expect(await kvGet(db, SYNC_MESSAGES_PER_CHAT_KEY)).toBe('500');
  });

  it.each([
    ['not-a-number', 0],
    ['-5', 0],
    ['Infinity', 0],
    ['25', 25],
  ])('sanitizes a corrupt persisted value %p to %p on hydrate', async (raw, expected) => {
    const db = await openTestDb();
    await kvSet(db, SYNC_MESSAGES_PER_CHAT_KEY, raw);
    await useSyncSettingsStore.getState().hydrate();
    expect(useSyncSettingsStore.getState().messagesPerChat).toBe(expected);
  });
});
