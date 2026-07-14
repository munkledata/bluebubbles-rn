import { getDatabase } from '@db/database';
import { kvGet, kvSet } from '@db/repositories';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { createTestDb } from '../support/testDb';

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
const mockGetDatabase = getDatabase as jest.Mock;

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

beforeEach(() => useFeatureSettingsStore.setState({ ...DEFAULTS, hydrated: false }));

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
