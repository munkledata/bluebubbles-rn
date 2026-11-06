import { buildBackupWithCustomFolders, restoreBackup } from '@/services/backup/backup';
import { BackupSchema } from '@/services/backup/backupSchema';
import { createTestDb } from '../support/testDb';
import { seedChat as seedChatFixture } from '../support/chatFixtures';

type Db = Awaited<ReturnType<typeof createTestDb>>;
const GUID = 'iMessage;-;a@b.com';

async function seedChat(t: Db): Promise<void> {
  await seedChatFixture(t.db, GUID, {
    participants: [{ address: 'a@b.com', service: 'iMessage' }],
    chatIdentifier: 'a@b.com',
    style: 45,
  });
}

function chatRow(t: Db): { isArchived: number; autoUnarchive: number } {
  return t.raw
    .prepare(
      'SELECT is_archived AS isArchived, auto_unarchive AS autoUnarchive FROM chats WHERE guid = ?',
    )
    .get(GUID) as { isArchived: number; autoUnarchive: number };
}

function archive(t: Db, autoUnarchive: 0 | 1): void {
  t.raw
    .prepare('UPDATE chats SET is_archived = 1, auto_unarchive = ? WHERE guid = ?')
    .run(autoUnarchive, GUID);
}

describe('backup v5: "Bring back from Archived" switch', () => {
  it('exports the switch and restores it onto a fresh install', async () => {
    const src = await createTestDb();
    await seedChat(src);
    archive(src, 0);
    const backup = await buildBackupWithCustomFolders(src.db, { exportedAt: 1 });
    expect(backup.version).toBe(5);
    expect(backup.chatCustomizations).toEqual([
      expect.objectContaining({ isArchived: 1, autoUnarchive: 0 }),
    ]);

    const dst = await createTestDb();
    await seedChat(dst);
    expect(chatRow(dst)).toEqual({ isArchived: 0, autoUnarchive: 1 });
    await restoreBackup(dst.db, backup);
    expect(chatRow(dst)).toEqual({ isArchived: 1, autoUnarchive: 0 });
  });

  it('an older (v4) backup leaves the local switch as it is', async () => {
    const src = await createTestDb();
    await seedChat(src);
    archive(src, 0);
    const v5 = await buildBackupWithCustomFolders(src.db, { exportedAt: 1 });
    const v4 = BackupSchema.parse({
      ...v5,
      version: 4,
      chatCustomizations: v5.chatCustomizations.map(({ autoUnarchive: _a, ...rest }) => rest),
    });

    const dst = await createTestDb();
    await seedChat(dst);
    archive(dst, 0); // this phone already had the switch off
    await restoreBackup(dst.db, v4);
    expect(chatRow(dst)).toEqual({ isArchived: 1, autoUnarchive: 0 });

    const fresh = await createTestDb();
    await seedChat(fresh);
    await restoreBackup(fresh.db, v4);
    expect(chatRow(fresh)).toEqual({ isArchived: 1, autoUnarchive: 1 }); // default stays on
  });

  it('rejects a v5 file whose switch is missing or not 0/1', async () => {
    const src = await createTestDb();
    await seedChat(src);
    archive(src, 1);
    const v5 = await buildBackupWithCustomFolders(src.db, { exportedAt: 1 });
    const strip = v5.chatCustomizations.map(({ autoUnarchive: _a, ...rest }) => rest);
    expect(BackupSchema.safeParse({ ...v5, chatCustomizations: strip }).success).toBe(false);
    const bad = v5.chatCustomizations.map((c) => ({ ...c, autoUnarchive: 2 }));
    expect(BackupSchema.safeParse({ ...v5, chatCustomizations: bad }).success).toBe(false);
  });
});
