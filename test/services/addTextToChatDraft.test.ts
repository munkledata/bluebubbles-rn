/**
 * New Message's "Open it" carries the typed text into the existing conversation's saved draft.
 * It must never overwrite a draft the chat already has, and must not write for a retired account.
 */
import type Database from 'better-sqlite3';
import { DRAFT_KV_PREFIX, kvGet } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { addTextToChatDraft, saveChatDraft } from '@/services/chatActions';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { createTestDb } from '../support/testDb';

let mockDb: AppDatabase;

jest.mock('@/services/clients', () => ({ http: {} }));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: jest.fn(() => mockDb) }));
jest.mock('@/services/realtimeControl', () => ({ getSocket: jest.fn(() => null) }));
jest.mock('@state/featureSettingsStore', () => ({
  useFeatureSettingsStore: { getState: () => ({ sendReadReceipts: true, hydrated: true }) },
}));
jest.mock('@state/sessionStore', () => ({ sessionAccessors: {} }));
jest.mock('@core/api', () => ({ chatsApi: {}, scheduledApi: {} }));

const CHAT = 'any;-;+15551234567';
const draftOf = (guid: string): Promise<string | null> =>
  kvGet(mockDb, `${DRAFT_KV_PREFIX}${guid}`);

describe('addTextToChatDraft', () => {
  let raw: Database.Database;

  beforeEach(async () => {
    resumeRealtimeDeliveries();
    ({ db: mockDb, raw } = await createTestDb());
  });

  afterEach(() => {
    resumeRealtimeDeliveries();
    raw.close();
  });

  it('saves the text as the draft when the chat has none', async () => {
    await addTextToChatDraft(CHAT, 'See you at 6');

    await expect(draftOf(CHAT)).resolves.toBe('See you at 6');
  });

  it('keeps an existing draft and adds the new text on a new line after it', async () => {
    await saveChatDraft(CHAT, 'Half-written reply');

    await addTextToChatDraft(CHAT, 'See you at 6');

    await expect(draftOf(CHAT)).resolves.toBe('Half-written reply\nSee you at 6');
  });

  it('does not add the same text twice when Open it is tapped again', async () => {
    await addTextToChatDraft(CHAT, 'See you at 6');
    await addTextToChatDraft(CHAT, 'See you at 6');

    await expect(draftOf(CHAT)).resolves.toBe('See you at 6');
  });

  it('still adds text that the draft merely happens to end with', async () => {
    await saveChatDraft(CHAT, 'Say hello');

    await addTextToChatDraft(CHAT, 'hello');

    await expect(draftOf(CHAT)).resolves.toBe('Say hello\nhello');
  });

  it('replaces a draft that is only whitespace', async () => {
    await saveChatDraft(CHAT, '  \n ');

    await addTextToChatDraft(CHAT, 'See you at 6');

    await expect(draftOf(CHAT)).resolves.toBe('See you at 6');
  });

  it('writes nothing for an account that was retired before the save', async () => {
    const retired = captureRealtimeDeliveryLease();
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();

    await addTextToChatDraft(CHAT, 'See you at 6', retired);

    await expect(draftOf(CHAT)).resolves.toBeNull();
  });
});
