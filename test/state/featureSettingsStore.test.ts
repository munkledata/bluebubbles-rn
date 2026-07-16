import { getDatabase } from '@db/database';
import { kvGet, kvSet } from '@db/repositories';
import { MAX_CONCURRENT_DOWNLOADS_KEY, useFeatureSettingsStore } from '@state/featureSettingsStore';
import {
  DEFAULT_MAX_CONCURRENT_DOWNLOADS,
  setMaxConcurrentDownloads,
} from '@/services/download/downloadService';
import { createTestDb } from '../support/testDb';

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
// Keep the real cap constants; spy the semaphore push so we can assert it fires on hydrate + set.
jest.mock('@/services/download/downloadService', () => ({
  ...jest.requireActual('@/services/download/downloadService'),
  setMaxConcurrentDownloads: jest.fn(),
}));

const mockGetDatabase = getDatabase as jest.Mock;
const mockApplyDownloads = setMaxConcurrentDownloads as jest.Mock;

const DEFAULTS = {
  privateApiEnabled: true,
  sendTypingIndicators: true,
  sendReadReceipts: true,
  autoDownloadAttachments: true,
  autoDownloadOnWifiOnly: false,
  sendWithReturn: false,
  showDeliveryTimestamps: true,
  compactChatList: false,
  messageNotifications: true,
} as const;

async function openTestDb() {
  const t = await createTestDb();
  mockGetDatabase.mockReturnValue(t.db);
  return t.db;
}

beforeEach(() => {
  mockApplyDownloads.mockClear();
  useFeatureSettingsStore.setState({
    ...DEFAULTS,
    maxConcurrentDownloads: DEFAULT_MAX_CONCURRENT_DOWNLOADS,
    hydrated: false,
  });
});

describe('featureSettingsStore', () => {
  it('hydrates every flag to its default when nothing was persisted', async () => {
    await openTestDb();
    await useFeatureSettingsStore.getState().hydrate();
    expect(useFeatureSettingsStore.getState()).toMatchObject({ ...DEFAULTS, hydrated: true });
  });

  it('an un-hydrated store already reads as the prior always-on behavior', () => {
    // Services read via getState() before launch hydration completes — the defaults must match.
    expect(useFeatureSettingsStore.getState()).toMatchObject(DEFAULTS);
  });

  it('survives the DB not being open yet (hydrated stays false, no throw)', async () => {
    mockGetDatabase.mockImplementation(() => {
      throw new Error('Database not initialized');
    });
    await useFeatureSettingsStore.getState().hydrate();
    expect(useFeatureSettingsStore.getState()).toMatchObject({ ...DEFAULTS, hydrated: false });
  });

  it('setFlag persists under the flag-specific kv key and hydrates back', async () => {
    const db = await openTestDb();
    await useFeatureSettingsStore.getState().setFlag('sendReadReceipts', false);
    expect(useFeatureSettingsStore.getState().sendReadReceipts).toBe(false);
    expect(await kvGet(db, 'privateApi.sendReadReceipts')).toBe('0');

    useFeatureSettingsStore.setState({ ...DEFAULTS, hydrated: false });
    await useFeatureSettingsStore.getState().hydrate();
    expect(useFeatureSettingsStore.getState()).toMatchObject({
      ...DEFAULTS,
      sendReadReceipts: false, // the persisted override
      hydrated: true,
    });
  });

  it('hydrate merges persisted overrides without disturbing untouched flags', async () => {
    const db = await openTestDb();
    await kvSet(db, 'attachments.autoDownload', '0');
    await kvSet(db, 'conversation.sendWithReturn', '1');
    await useFeatureSettingsStore.getState().hydrate();
    expect(useFeatureSettingsStore.getState()).toMatchObject({
      ...DEFAULTS,
      autoDownloadAttachments: false,
      sendWithReturn: true,
      hydrated: true,
    });
  });

  it('setFlag keeps the in-memory toggle when the persist fails', async () => {
    mockGetDatabase.mockImplementation(() => {
      throw new Error('Database not initialized');
    });
    await useFeatureSettingsStore.getState().setFlag('compactChatList', true);
    expect(useFeatureSettingsStore.getState().compactChatList).toBe(true);
  });
});

describe('featureSettingsStore — maxConcurrentDownloads value setting', () => {
  it('hydrates the default when nothing was persisted', async () => {
    await openTestDb();
    await useFeatureSettingsStore.getState().hydrate();
    expect(useFeatureSettingsStore.getState()).toMatchObject({
      maxConcurrentDownloads: DEFAULT_MAX_CONCURRENT_DOWNLOADS,
      hydrated: true,
    });
  });

  it('round-trips a persisted cap', async () => {
    const db = await openTestDb();
    await useFeatureSettingsStore.getState().setMaxConcurrentDownloads(4);
    expect(await kvGet(db, MAX_CONCURRENT_DOWNLOADS_KEY)).toBe('4');
    useFeatureSettingsStore.setState({ maxConcurrentDownloads: 2, hydrated: false });
    await useFeatureSettingsStore.getState().hydrate();
    expect(useFeatureSettingsStore.getState()).toMatchObject({
      maxConcurrentDownloads: 4,
      hydrated: true,
    });
  });

  it.each([
    [0, 1], // below the floor
    [99, 6], // above MAX_CONCURRENT_DOWNLOADS_LIMIT
    [3.9, 3], // fractional → floored
    [NaN, DEFAULT_MAX_CONCURRENT_DOWNLOADS],
  ])('clamps setMaxConcurrentDownloads(%p) to %p', async (input, expected) => {
    await openTestDb();
    await useFeatureSettingsStore.getState().setMaxConcurrentDownloads(input);
    expect(useFeatureSettingsStore.getState().maxConcurrentDownloads).toBe(expected);
  });

  it('sanitizes a corrupt persisted value on hydrate', async () => {
    const db = await openTestDb();
    await kvSet(db, MAX_CONCURRENT_DOWNLOADS_KEY, 'lots');
    await useFeatureSettingsStore.getState().hydrate();
    expect(useFeatureSettingsStore.getState().maxConcurrentDownloads).toBe(
      DEFAULT_MAX_CONCURRENT_DOWNLOADS,
    );
  });

  it('pushes the cap into the download semaphore on hydrate and on set', async () => {
    await openTestDb();
    await useFeatureSettingsStore.getState().hydrate();
    expect(mockApplyDownloads).toHaveBeenCalledWith(DEFAULT_MAX_CONCURRENT_DOWNLOADS);
    mockApplyDownloads.mockClear();
    await useFeatureSettingsStore.getState().setMaxConcurrentDownloads(4);
    expect(mockApplyDownloads).toHaveBeenCalledWith(4);
  });

  it('survives the DB not being open yet (hydrated stays false, no throw)', async () => {
    mockGetDatabase.mockImplementation(() => {
      throw new Error('Database not initialized');
    });
    await useFeatureSettingsStore.getState().hydrate();
    expect(useFeatureSettingsStore.getState().hydrated).toBe(false);
  });
});
