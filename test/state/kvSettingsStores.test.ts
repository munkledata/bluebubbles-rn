/**
 * The two simple kv-hydrated settings (redacted mode, sync cap) share the same
 * contract: hydrate reads from `kv` via `getDatabase()`, MUST survive the DB not being open yet
 * (leave `hydrated` false, no throw — the documented launch-order crash class), and setters are
 * optimistic (in-memory first, best-effort persist).
 */
import { getDatabase } from '@db/database';
import { kvGet, kvSet } from '@db/repositories';
import { REDACTED_MODE_KEY, useRedactedModeStore } from '@state/redactedModeStore';
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
  useRedactedModeStore.setState({ enabled: false, hydrated: false });
  useSyncSettingsStore.setState({ messagesPerChat: 0, hydrated: false });
});

describe('hydrate with the DB not open yet (app launch before connect)', () => {
  it('leaves hydrated=false and the default value, without throwing', async () => {
    closeDb();
    await useRedactedModeStore.getState().hydrate();
    await useSyncSettingsStore.getState().hydrate();
    expect(useRedactedModeStore.getState()).toMatchObject({ enabled: false, hydrated: false });
    expect(useSyncSettingsStore.getState()).toMatchObject({ messagesPerChat: 0, hydrated: false });
  });
});

describe('redactedModeStore', () => {
  it('hydrates OFF when the key was never persisted', async () => {
    await openTestDb();
    await useRedactedModeStore.getState().hydrate();
    expect(useRedactedModeStore.getState()).toMatchObject({ enabled: false, hydrated: true });
  });

  it('round-trips: setEnabled persists, a fresh hydrate reads it back', async () => {
    const db = await openTestDb();
    await useRedactedModeStore.getState().setEnabled(true);
    expect(await kvGet(db, REDACTED_MODE_KEY)).toBe('1');
    useRedactedModeStore.setState({ enabled: false, hydrated: false });
    await useRedactedModeStore.getState().hydrate();
    expect(useRedactedModeStore.getState()).toMatchObject({ enabled: true, hydrated: true });
  });

  it('toggle still applies in-memory when the persist fails', async () => {
    closeDb();
    await useRedactedModeStore.getState().setEnabled(true);
    expect(useRedactedModeStore.getState().enabled).toBe(true);
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
