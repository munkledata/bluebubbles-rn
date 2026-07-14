import { getDatabase } from '@db/database';
import { kvGet, kvSet } from '@db/repositories';
import {
  MAX_CONCURRENT_DOWNLOADS_KEY,
  useDownloadSettingsStore,
} from '@state/downloadSettingsStore';
import { DEFAULT_MAX_CONCURRENT_DOWNLOADS } from '@/services/download/downloadService';
import { createTestDb } from '../support/testDb';

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
const mockGetDatabase = getDatabase as jest.Mock;

async function openTestDb() {
  const t = await createTestDb();
  mockGetDatabase.mockReturnValue(t.db);
  return t.db;
}

beforeEach(() =>
  useDownloadSettingsStore.setState({
    maxConcurrent: DEFAULT_MAX_CONCURRENT_DOWNLOADS,
    hydrated: false,
  }),
);

describe('downloadSettingsStore', () => {
  it('hydrates the default when nothing was persisted', async () => {
    await openTestDb();
    await useDownloadSettingsStore.getState().hydrate();
    expect(useDownloadSettingsStore.getState()).toMatchObject({
      maxConcurrent: DEFAULT_MAX_CONCURRENT_DOWNLOADS,
      hydrated: true,
    });
  });

  it('round-trips a persisted cap', async () => {
    const db = await openTestDb();
    await useDownloadSettingsStore.getState().setMaxConcurrent(4);
    expect(await kvGet(db, MAX_CONCURRENT_DOWNLOADS_KEY)).toBe('4');
    useDownloadSettingsStore.setState({ maxConcurrent: 2, hydrated: false });
    await useDownloadSettingsStore.getState().hydrate();
    expect(useDownloadSettingsStore.getState()).toMatchObject({ maxConcurrent: 4, hydrated: true });
  });

  it.each([
    [0, 1], // below the floor
    [99, 6], // above MAX_CONCURRENT_DOWNLOADS_LIMIT
    [3.9, 3], // fractional → floored
    [NaN, DEFAULT_MAX_CONCURRENT_DOWNLOADS],
  ])('clamps setMaxConcurrent(%p) to %p', async (input, expected) => {
    await openTestDb();
    await useDownloadSettingsStore.getState().setMaxConcurrent(input);
    expect(useDownloadSettingsStore.getState().maxConcurrent).toBe(expected);
  });

  it('sanitizes a corrupt persisted value on hydrate', async () => {
    const db = await openTestDb();
    await kvSet(db, MAX_CONCURRENT_DOWNLOADS_KEY, 'lots');
    await useDownloadSettingsStore.getState().hydrate();
    expect(useDownloadSettingsStore.getState().maxConcurrent).toBe(
      DEFAULT_MAX_CONCURRENT_DOWNLOADS,
    );
  });

  it('survives the DB not being open yet (hydrated stays false, no throw)', async () => {
    mockGetDatabase.mockImplementation(() => {
      throw new Error('Database not initialized');
    });
    await useDownloadSettingsStore.getState().hydrate();
    expect(useDownloadSettingsStore.getState().hydrated).toBe(false);
  });
});
