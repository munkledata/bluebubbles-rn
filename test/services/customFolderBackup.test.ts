import { Chat } from '@core/models';
import { SecretBox } from '@core/crypto';
import {
  createCustomFolder,
  listCustomFolderChatGuids,
  listCustomFolders,
  replaceCustomFolderMembership,
  setCustomFolderShowUnreadBadge,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import {
  buildBackup,
  buildBackupWithCustomFolders,
  openBackup,
  restoreBackup,
  sealBackup,
} from '@/services/backup/backup';
import type { Backup } from '@/services/backup/backupSchema';
import { createLibsodiumBackend } from '../support/libsodiumBackend';
import { createTestDb } from '../support/testDb';

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

async function seedChat(
  t: TestDb,
  guid: string,
  options: { chatIdentifier?: string | null; participant?: string } = {},
): Promise<void> {
  const participant = options.participant ?? `${guid}@example.test`;
  const handles = await upsertHandles(t.db, [{ address: participant, service: 'iMessage' }]);
  await upsertChats(
    t.db,
    [
      Chat.parse({
        guid,
        chatIdentifier: options.chatIdentifier === undefined ? guid : options.chatIdentifier,
        displayName: null,
        style: 45,
        participants: [{ address: participant, service: 'iMessage' }],
      }),
    ],
    handles,
  );
}

describe('custom-folder backup v3', () => {
  it('deduplicates overlapping identities and restores folders non-destructively and idempotently', async () => {
    const source = await createTestDb();
    await seedChat(source, 'iMessage;-;source-a', {
      chatIdentifier: 'stable-a',
      participant: 'a@example.test',
    });
    await seedChat(source, 'iMessage;-;source-b', {
      chatIdentifier: 'stable-b',
      participant: 'b@example.test',
    });
    const sourceWork = await createCustomFolder(source.db, 'Work');
    const sourceFamily = await createCustomFolder(source.db, 'Family');
    await setCustomFolderShowUnreadBadge(source.db, sourceWork.id, false);
    await replaceCustomFolderMembership(source.db, sourceWork.id, [
      'iMessage;-;source-a',
      'iMessage;-;source-b',
      'temporarily-absent',
    ]);
    await replaceCustomFolderMembership(source.db, sourceFamily.id, ['iMessage;-;source-b']);

    const backup = await buildBackupWithCustomFolders(source.db, {
      exportedAt: 123,
      appVersion: '1.0.0',
    });
    expect(backup.version).toBe(3);
    expect(backup.customFolderChatIdentities).toHaveLength(2);
    expect(backup.customFolders.map((folder) => folder.name)).toEqual(['Work', 'Family']);
    const workBackup = backup.customFolders[0]!;
    const familyBackup = backup.customFolders[1]!;
    expect(workBackup).toMatchObject({
      showUnreadBadge: 0,
      sourceMemberCount: 3,
    });
    expect(workBackup.memberIndexes).toHaveLength(2);
    expect(familyBackup).toMatchObject({
      showUnreadBadge: 1,
      sourceMemberCount: 1,
    });
    expect(familyBackup.memberIndexes).toHaveLength(1);
    const sharedIdentityIndex = backup.customFolderChatIdentities.findIndex(
      (identity) => identity.serverChatIdentifier === 'stable-b',
    );
    expect(sharedIdentityIndex).toBeGreaterThanOrEqual(0);
    expect(workBackup.memberIndexes).toContain(sharedIdentityIndex);
    expect(familyBackup.memberIndexes).toEqual([sharedIdentityIndex]);
    const box = new SecretBox(await createLibsodiumBackend(), {
      opsLimit: 1,
      memLimit: 8 * 1024 * 1024,
    });
    const encrypted = await sealBackup(box, backup, 'folder-backup-passphrase');
    expect(await openBackup(box, encrypted, 'folder-backup-passphrase')).toEqual(backup);

    const target = await createTestDb();
    await seedChat(target, 'iMessage;-;local-only', { chatIdentifier: 'local-only' });
    await seedChat(target, 'iMessage;-;target-a', {
      chatIdentifier: 'stable-a',
      participant: 'a@example.test',
    });
    await seedChat(target, 'iMessage;-;target-b', {
      chatIdentifier: 'stable-b',
      participant: 'b@example.test',
    });
    await createCustomFolder(target.db, 'Local only');
    const targetWork = await createCustomFolder(target.db, 'Work');
    await replaceCustomFolderMembership(target.db, targetWork.id, ['iMessage;-;local-only']);

    const firstRestore = await restoreBackup(target.db, backup);
    expect(firstRestore).toMatchObject({
      customFolders: 2,
      customFoldersSkipped: 0,
      customFolderMemberships: 3,
      customFolderMembershipsSkipped: 1,
    });
    const restoredFolders = await listCustomFolders(target.db);
    expect(
      restoredFolders.map(({ name, sortOrder, chatCount, showUnreadBadge }) => ({
        name,
        sortOrder,
        chatCount,
        showUnreadBadge,
      })),
    ).toEqual([
      { name: 'Local only', sortOrder: 0, chatCount: 0, showUnreadBadge: 1 },
      { name: 'Work', sortOrder: 1, chatCount: 3, showUnreadBadge: 0 },
      { name: 'Family', sortOrder: 2, chatCount: 1, showUnreadBadge: 1 },
    ]);
    expect(await listCustomFolderChatGuids(target.db, targetWork.id)).toEqual([
      'iMessage;-;local-only',
      'iMessage;-;target-a',
      'iMessage;-;target-b',
    ]);
    const targetFamily = restoredFolders.find((folder) => folder.name === 'Family')!;
    expect(await listCustomFolderChatGuids(target.db, targetFamily.id)).toEqual([
      'iMessage;-;target-b',
    ]);

    await expect(restoreBackup(target.db, backup)).resolves.toMatchObject(firstRestore);
    expect(await listCustomFolderChatGuids(target.db, targetWork.id)).toEqual([
      'iMessage;-;local-only',
      'iMessage;-;target-a',
      'iMessage;-;target-b',
    ]);
    expect(await listCustomFolderChatGuids(target.db, targetFamily.id)).toEqual([
      'iMessage;-;target-b',
    ]);
    expect((await listCustomFolders(target.db)).map((folder) => folder.name)).toEqual([
      'Local only',
      'Work',
      'Family',
    ]);
  });

  it('leaves local folders untouched when restoring legacy v1 and v2 backups', async () => {
    const target = await createTestDb();
    const localFolder = await createCustomFolder(target.db, 'Keep me');
    await replaceCustomFolderMembership(target.db, localFolder.id, ['temporarily-absent']);
    const empty = await createTestDb();
    const v2 = await buildBackup(empty.db, { exportedAt: 2 });
    const v1: Backup = {
      version: 1,
      exportedAt: 1,
      kv: [],
      themes: [],
      chatCustomizations: [],
    };

    for (const backup of [v1, v2]) {
      await expect(restoreBackup(target.db, backup)).resolves.toMatchObject({
        customFolders: 0,
        customFoldersSkipped: 0,
        customFolderMemberships: 0,
        customFolderMembershipsSkipped: 0,
      });
    }
    expect(await listCustomFolderChatGuids(target.db, localFolder.id)).toEqual([
      'temporarily-absent',
    ]);
    expect(await listCustomFolders(target.db)).toMatchObject([
      { name: 'Keep me', sortOrder: 0, chatCount: 1, showUnreadBadge: 1 },
    ]);
  });

  it('omits over-limit identity evidence without losing the durable source count', async () => {
    const source = await createTestDb();
    await seedChat(source, 'oversized-participant', {
      chatIdentifier: null,
      participant: 'a'.repeat(4_097),
    });
    await seedChat(source, 'oversized-identifier', {
      // SQLite counts each astral code point once; JavaScript/Zod counts its two UTF-16 units.
      chatIdentifier: '😀'.repeat(2_049),
      participant: 'valid@example.test',
    });
    const folder = await createCustomFolder(source.db, 'Oversized evidence');
    await replaceCustomFolderMembership(source.db, folder.id, [
      'oversized-participant',
      'oversized-identifier',
    ]);

    const backup = await buildBackupWithCustomFolders(source.db, { exportedAt: 1 });
    expect(backup.customFolderChatIdentities).toEqual([]);
    expect(backup.customFolders).toEqual([
      {
        name: 'Oversized evidence',
        showUnreadBadge: 1,
        sourceMemberCount: 2,
        memberIndexes: [],
      },
    ]);
  });
});
