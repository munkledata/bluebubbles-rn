import {
  CustomFolderMembershipLimitError,
  MAX_CUSTOM_FOLDER_MEMBERSHIPS_TOTAL,
} from '@db/repositories';
import { createTestDb } from '../support/testDb';
import {
  createCustomFolder,
  listCustomFolderChatGuids,
  replaceCustomFolderMembership,
} from '../support/repositoryWrappers';

// Folders used to accept up to 100 × 5,000 members while a backup holds at most 25,000 in total,
// so a large folder set made every later backup fail. The total is now enforced when saving.
describe('custom folder total membership limit', () => {
  function seedOtherFolder(
    raw: Awaited<ReturnType<typeof createTestDb>>['raw'],
    count: number,
  ): void {
    const insertFolder = raw.prepare(
      'INSERT INTO custom_folders (name, sort_order, show_unread_badge) VALUES (?, ?, 1)',
    );
    const insertMember = raw.prepare(
      'INSERT INTO custom_folder_members (folder_id, chat_guid) VALUES (?, ?)',
    );
    raw.transaction(() => {
      let remaining = count;
      for (let folder = 0; remaining > 0; folder += 1) {
        const id = Number(insertFolder.run(`Seed ${folder}`, 1_000 + folder).lastInsertRowid);
        const batch = Math.min(remaining, 5_000);
        for (let index = 0; index < batch; index += 1) {
          insertMember.run(id, `iMessage;-;+1555${folder}${String(index).padStart(5, '0')}`);
        }
        remaining -= batch;
      }
    })();
  }

  it('refuses a save that would take all folders past the total a backup can hold', async () => {
    const t = await createTestDb();
    seedOtherFolder(t.raw, MAX_CUSTOM_FOLDER_MEMBERSHIPS_TOTAL - 1);
    const { id: folderId } = await createCustomFolder(t.db, 'Mine');

    await expect(
      replaceCustomFolderMembership(t.db, folderId, ['chat-a', 'chat-b']),
    ).rejects.toBeInstanceOf(CustomFolderMembershipLimitError);
    await expect(listCustomFolderChatGuids(t.db, folderId)).resolves.toEqual([]);

    await expect(replaceCustomFolderMembership(t.db, folderId, ['chat-a'])).resolves.toBe(true);
    await expect(listCustomFolderChatGuids(t.db, folderId)).resolves.toEqual(['chat-a']);
  });

  it('counts the saved folder once, so re-saving an existing selection stays allowed', async () => {
    const t = await createTestDb();
    seedOtherFolder(t.raw, MAX_CUSTOM_FOLDER_MEMBERSHIPS_TOTAL - 2);
    const { id: folderId } = await createCustomFolder(t.db, 'Mine');
    await replaceCustomFolderMembership(t.db, folderId, ['chat-a', 'chat-b']);

    await expect(replaceCustomFolderMembership(t.db, folderId, ['chat-b', 'chat-a'])).resolves.toBe(
      true,
    );
  });
});
