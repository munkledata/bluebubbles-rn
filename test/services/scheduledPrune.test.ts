/**
 * P7 — the Scheduled screen's server reconcile must not prune a row that did not exist when the
 * server built its answer.
 *
 * `GET /scheduled` describes one instant, and the prune runs against the local table as it is when
 * the response lands. Gator has no PUT, so the screen's Edit is delete-then-create: it mints a NEW
 * server id. Do that while the list fetch is in flight and the reconcile deleted the only local
 * handle to a message the server will still fire — the user's edited message goes out with nothing
 * on the Scheduled screen to show for it (and no way to cancel it).
 *
 * The barrel wires native modules at import time, so the native leaves are mocked (composition-root
 * clients / expo uploader / contacts picker); the DB and the reconcile itself are real.
 */
import { Chat } from '@core/models';
import { insertScheduled, listAllScheduled, upsertChats, upsertHandles } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/clients', () => ({ http: {} }));
jest.mock('@/services/contacts/contactsService', () => ({ pickContact: jest.fn() }));
jest.mock('@/services/send/attachmentUpload', () => ({
  expoAttachmentUploader: jest.fn(),
  expoFileExists: jest.fn(async () => true),
}));
jest.mock('@ui/toast/toastStore', () => ({ showToast: jest.fn() }));
jest.mock('@core/api/endpoints/scheduled', () => ({
  getScheduled: jest.fn(),
  createScheduled: jest.fn(),
  deleteScheduled: jest.fn(),
}));

// eslint-disable-next-line import/first
import { syncScheduledFromServer } from '@/services/send';
// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';
// eslint-disable-next-line import/first
import { getScheduled } from '@core/api/endpoints/scheduled';

const mockGetScheduled = getScheduled as jest.Mock;

async function seedChat(db: AppDatabase): Promise<void> {
  const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
  await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: [{ address: 'a@b.com' }] })],
    handles,
  );
}

/** The shape `getScheduled` returns for one server-backed row. */
const item = (id: string, text: string) => ({
  id,
  chatGuid: 'c1',
  text,
  scheduledFor: 9_000_000,
  status: 'pending',
});

const serverIdsOf = async (db: AppDatabase): Promise<(string | null)[]> =>
  (await listAllScheduled(db)).map((r) => r.serverId);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('syncScheduledFromServer — prune exposure is snapshotted before the round trip', () => {
  it('keeps a row created WHILE the list fetch was in flight', async () => {
    const { db } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    await seedChat(db);
    await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'existing',
      scheduledFor: 9_000_000,
      serverId: 'srv-old',
    });

    // The user taps Edit while the GET is in flight: the old server message is deleted and a new
    // one created, so the local row is repointed at a server id the response cannot mention.
    mockGetScheduled.mockImplementation(async () => {
      await insertScheduled(db, {
        chatGuid: 'c1',
        text: 'edited mid-fetch',
        scheduledFor: 9_500_000,
        serverId: 'srv-new',
      });
      return [item('srv-old', 'existing')];
    });

    await syncScheduledFromServer();

    const ids = await serverIdsOf(db);
    expect(ids).toContain('srv-new'); // survived the prune
    expect(ids).toContain('srv-old');
  });

  it('still prunes a row the server dropped that WAS exposed before the fetch', async () => {
    const { db } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    await seedChat(db);
    await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'kept',
      scheduledFor: 9_000_000,
      serverId: 'srv-keep',
    });
    await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'cancelled elsewhere',
      scheduledFor: 9_000_000,
      serverId: 'srv-stale',
    });
    mockGetScheduled.mockResolvedValue([item('srv-keep', 'kept')]);

    await syncScheduledFromServer();

    expect(await serverIdsOf(db)).toEqual(['srv-keep']);
  });

  it('an EMPTY server view still prunes nothing, even with a row created mid-fetch', async () => {
    const { db } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    await seedChat(db);
    await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'existing',
      scheduledFor: 9_000_000,
      serverId: 'srv-old',
    });
    // A transient empty response must never be treated as "the server has nothing" — and the
    // mid-fetch row must not turn that empty keep-set into a non-empty one that prunes the rest.
    mockGetScheduled.mockImplementation(async () => {
      await insertScheduled(db, {
        chatGuid: 'c1',
        text: 'new',
        scheduledFor: 9_500_000,
        serverId: 'srv-new',
      });
      return [];
    });

    await syncScheduledFromServer();

    const ids = await serverIdsOf(db);
    expect(ids).toContain('srv-old');
    expect(ids).toContain('srv-new');
  });

  it('leaves local-only rows alone (they have no server id to be reported)', async () => {
    const { db } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValue(db);
    await seedChat(db);
    await insertScheduled(db, { chatGuid: 'c1', text: 'local only', scheduledFor: 9_000_000 });
    mockGetScheduled.mockResolvedValue([item('srv-x', 'server row')]);

    await syncScheduledFromServer();

    expect(await serverIdsOf(db)).toEqual(expect.arrayContaining([null, 'srv-x']));
  });
});
