import {
  addChatToCustomFolderWithinTransaction,
  CustomFolderMembershipLimitError,
  MAX_CUSTOM_FOLDER_MEMBERS,
  MAX_CUSTOM_FOLDER_MEMBERSHIPS_TOTAL,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { createTestDb } from '../support/testDb';
import { createCustomFolder, listCustomFolderChatGuids } from '../support/repositoryWrappers';

type Db = Awaited<ReturnType<typeof createTestDb>>;

const add = (t: Db, folderId: number, chatGuid: string) =>
  withDbTransaction(t.db, (db, context) =>
    addChatToCustomFolderWithinTransaction(context, folderId, chatGuid),
  );

function seedMembers(t: Db, folderId: number, count: number, prefix: string): void {
  const insert = t.raw.prepare(
    'INSERT INTO custom_folder_members (folder_id, chat_guid) VALUES (?, ?)',
  );
  t.raw.transaction(() => {
    for (let i = 0; i < count; i += 1) insert.run(folderId, `${prefix}${i}`);
  })();
}

describe('"Add to Folder…": one chat into one folder', () => {
  it('adds a chat, and adding it again changes nothing', async () => {
    const t = await createTestDb();
    const { id } = await createCustomFolder(t.db, 'Family');
    await expect(add(t, id, 'iMessage;-;+15551234567')).resolves.toBe('added');
    await expect(add(t, id, 'iMessage;-;+15551234567')).resolves.toBe('already');
    await expect(listCustomFolderChatGuids(t.db, id)).resolves.toEqual(['iMessage;-;+15551234567']);
  });

  it('keeps the existing members (it adds, it never replaces)', async () => {
    const t = await createTestDb();
    const { id } = await createCustomFolder(t.db, 'Work');
    await add(t, id, 'chat-a');
    await add(t, id, 'chat-b');
    await expect(listCustomFolderChatGuids(t.db, id)).resolves.toEqual(['chat-a', 'chat-b']);
  });

  it('reports a folder that no longer exists', async () => {
    const t = await createTestDb();
    await expect(add(t, 987_654, 'chat-a')).resolves.toBe('missing');
  });

  it('refuses an invalid chat guid', async () => {
    const t = await createTestDb();
    const { id } = await createCustomFolder(t.db, 'Bad');
    await expect(add(t, id, '')).rejects.toBeInstanceOf(RangeError);
    await expect(add(t, id, 'a\u0000b')).rejects.toBeInstanceOf(RangeError);
  });

  it('refuses a folder already at its own cap', async () => {
    const t = await createTestDb();
    const { id } = await createCustomFolder(t.db, 'Full');
    seedMembers(t, id, MAX_CUSTOM_FOLDER_MEMBERS, 'full-');
    await expect(add(t, id, 'one-more')).rejects.toBeInstanceOf(CustomFolderMembershipLimitError);
    // An existing member is still reported as already there, not as over the limit.
    await expect(add(t, id, 'full-0')).resolves.toBe('already');
  });

  it('refuses when all folders together are at the total a backup can hold', async () => {
    const t = await createTestDb();
    const { id } = await createCustomFolder(t.db, 'Mine');
    let remaining = MAX_CUSTOM_FOLDER_MEMBERSHIPS_TOTAL;
    for (let folder = 0; remaining > 0; folder += 1) {
      const other = await createCustomFolder(t.db, `Other ${folder}`);
      const batch = Math.min(remaining, MAX_CUSTOM_FOLDER_MEMBERS);
      seedMembers(t, other.id, batch, `o${folder}-`);
      remaining -= batch;
    }
    await expect(add(t, id, 'chat-a')).rejects.toBeInstanceOf(CustomFolderMembershipLimitError);
    await expect(listCustomFolderChatGuids(t.db, id)).resolves.toEqual([]);
  });
});
