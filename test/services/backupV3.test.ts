import { Chat } from '@core/models';
import {
  createCustomFolder,
  kvGet,
  kvSet,
  listCustomFolderChatGuids,
  listCustomFolders,
  replaceCustomFolderMembership,
  setChatCustomization,
  setCustomFolderShowUnreadBadge,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import { MAX_CUSTOM_FOLDER_MEMBERS, MAX_CUSTOM_FOLDERS } from '@db/repositories/customFolders';
import {
  buildBackupWithCustomFolders,
  openBackup,
  restoreBackup,
  sealBackup,
} from '@/services/backup/backup';
import { withDbTransaction } from '@db/transaction';
import {
  BACKUP_LIMITS,
  BackupSchema,
  type Backup,
  type BackupV3,
  type PortableChatIdentity,
} from '@/services/backup/backupSchema';
import { SecretBox } from '@core/crypto';
import { createLibsodiumBackend } from '../support/libsodiumBackend';
import { createTestDb } from '../support/testDb';

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

interface SeedChatOptions {
  chatIdentifier?: string | null;
  participants?: { address: string; service?: string | null }[];
  style?: number | null;
}

async function seedChat(t: TestDb, guid: string, options: SeedChatOptions = {}): Promise<void> {
  const participants = options.participants ?? [];
  const handles = await upsertHandles(t.db, participants);
  await upsertChats(
    t.db,
    [
      Chat.parse({
        guid,
        chatIdentifier: options.chatIdentifier ?? null,
        displayName: 'Backup fixture',
        style: options.style ?? 45,
        participants,
      }),
    ],
    handles,
  );
}

function directIdentity(
  serverChatIdentifier: string | null,
  participants: PortableChatIdentity['participants'] = [],
): PortableChatIdentity {
  return {
    version: 1,
    service: 'iMessage',
    kind: 'direct',
    serverChatIdentifier,
    participants,
  };
}

function emptyV3(): BackupV3 {
  return {
    version: 3,
    exportedAt: 1,
    kv: [],
    themes: [],
    chatCustomizations: [],
    customFolderChatIdentities: [],
    customFolders: [],
  };
}

async function readFolderState(t: TestDb) {
  const rows = [];
  for (const folder of await listCustomFolders(t.db)) {
    rows.push({
      name: folder.name,
      sortOrder: folder.sortOrder,
      showUnreadBadge: folder.showUnreadBadge,
      members: await listCustomFolderChatGuids(t.db, folder.id),
    });
  }
  return rows;
}

async function expectBoundedExportRejection(t: TestDb, message: string): Promise<void> {
  await expect(buildBackupWithCustomFolders(t.db, { exportedAt: 44 })).rejects.toThrow(message);
  // A probe rejection rolls back and releases the one process-wide writer slot.
  await expect(kvSet(t.db, 'theme.preset', 'writer-after-rejection')).resolves.toBeUndefined();
}

function captureAllSql(db: TestDb['db']): { db: TestDb['db']; statements: string[] } {
  const statements: string[] = [];
  const instrumented = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'all' && typeof value === 'function') {
        return (...args: unknown[]) => {
          const dialect = (
            target as unknown as {
              dialect: { sqlToQuery(query: unknown): { sql: string } };
            }
          ).dialect;
          statements.push(dialect.sqlToQuery(args[0]).sql);
          return Reflect.apply(value, target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as TestDb['db'];
  return { db: instrumented, statements };
}

describe('backup v3 custom folders', () => {
  it('queues the complete export behind a rolling-back neighbour', async () => {
    const source = await createTestDb();
    await kvSet(source.db, 'theme.preset', 'committed-theme');
    source.raw
      .prepare('INSERT INTO themes (name, mode, tokens, is_preset) VALUES (?, ?, ?, 0)')
      .run('Committed theme', 'dark', '{"generation":"committed"}');
    await seedChat(source, 'snapshot-chat', { chatIdentifier: 'snapshot-stable' });
    await setChatCustomization(source.db, 'snapshot-chat', { customName: 'Committed chat' });
    await createCustomFolder(source.db, 'Committed folder');

    let markNeighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const neighbourStarted = new Promise<void>((resolve) => {
      markNeighbourStarted = resolve;
    });
    const neighbourRelease = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(source.db, async () => {
      source.raw.prepare("UPDATE kv SET value = 'phantom-theme' WHERE key = 'theme.preset'").run();
      source.raw
        .prepare(
          'UPDATE themes SET tokens = \'{"generation":"phantom"}\' WHERE name = \'Committed theme\'',
        )
        .run();
      source.raw
        .prepare("UPDATE chats SET custom_name = 'Phantom chat' WHERE guid = 'snapshot-chat'")
        .run();
      source.raw
        .prepare(
          "UPDATE custom_folders SET name = 'Phantom folder', show_unread_badge = 0 WHERE name = 'Committed folder'",
        )
        .run();
      markNeighbourStarted();
      await neighbourRelease;
      throw new Error('neighbour rollback');
    });
    await neighbourStarted;

    const exporting = buildBackupWithCustomFolders(source.db, { exportedAt: 42 });
    try {
      expect(source.raw.prepare("SELECT value FROM kv WHERE key = 'theme.preset'").get()).toEqual({
        value: 'phantom-theme',
      });
    } finally {
      releaseNeighbour();
      await Promise.allSettled([neighbour, exporting]);
    }

    await expect(neighbour).rejects.toThrow('neighbour rollback');
    const backup = await exporting;
    expect(backup.kv).toContainEqual({ key: 'theme.preset', value: 'committed-theme' });
    expect(backup.kv).not.toContainEqual({ key: 'theme.preset', value: 'phantom-theme' });
    expect(backup.themes).toContainEqual(
      expect.objectContaining({ name: 'Committed theme', tokens: '{"generation":"committed"}' }),
    );
    expect(backup.chatCustomizations).toContainEqual(
      expect.objectContaining({ customName: 'Committed chat' }),
    );
    expect(backup.customFolders).toEqual([
      expect.objectContaining({ name: 'Committed folder', showUnreadBadge: 1 }),
    ]);
  });

  it('reads base data and folders from the same committed generation', async () => {
    const source = await createTestDb();
    await kvSet(source.db, 'theme.preset', 'generation-old');
    await createCustomFolder(source.db, 'Folder old');

    let markFirstReadStarted!: () => void;
    let releaseFirstRead!: () => void;
    const firstReadStarted = new Promise<void>((resolve) => {
      markFirstReadStarted = resolve;
    });
    const firstReadRelease = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let interceptedFirstRead = false;
    const interceptedDb = new Proxy(source.db, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'all' && typeof value === 'function') {
          return async (...args: unknown[]) => {
            if (!interceptedFirstRead) {
              interceptedFirstRead = true;
              markFirstReadStarted();
              await firstReadRelease;
            }
            return (value as (...values: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as typeof source.db;

    const exporting = buildBackupWithCustomFolders(interceptedDb, { exportedAt: 43 });
    await firstReadStarted;
    const writer = withDbTransaction(source.db, async () => {
      source.raw.prepare("UPDATE kv SET value = 'generation-new' WHERE key = 'theme.preset'").run();
      source.raw
        .prepare(
          "UPDATE custom_folders SET name = 'Folder new', show_unread_badge = 0 WHERE name = 'Folder old'",
        )
        .run();
    });
    releaseFirstRead();

    const backup = await exporting;
    await writer;
    expect(backup.kv).toContainEqual({ key: 'theme.preset', value: 'generation-old' });
    expect(backup.customFolders).toEqual([
      expect.objectContaining({ name: 'Folder old', showUnreadBadge: 1 }),
    ]);
    expect(source.raw.prepare("SELECT value FROM kv WHERE key = 'theme.preset'").get()).toEqual({
      value: 'generation-new',
    });
    expect(source.raw.prepare('SELECT name, show_unread_badge FROM custom_folders').get()).toEqual({
      name: 'Folder new',
      show_unread_badge: 0,
    });
  });

  it('probes only allowlisted settings and rejects an oversized allowed value', async () => {
    const source = await createTestDb();
    await kvSet(source.db, 'theme.preset', 'allowed-value');
    source.raw
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?)')
      .run('draft.private-chat', 'x'.repeat(BACKUP_LIMITS.plaintextBytes + 1));

    const backup = await buildBackupWithCustomFolders(source.db, { exportedAt: 44 });
    expect(backup.kv).toEqual([{ key: 'theme.preset', value: 'allowed-value' }]);
    expect(JSON.stringify(backup)).not.toContain('draft.private-chat');

    source.raw
      .prepare('UPDATE kv SET value = ? WHERE key = ?')
      .run('x'.repeat(BACKUP_LIMITS.valueCharacters + 1), 'theme.preset');
    await expectBoundedExportRejection(source, 'Backup export kv value exceeds its safety bound.');
  });

  it('rejects max-plus-one theme and customized-chat collections', async () => {
    const themeSource = await createTestDb();
    const insertTheme = themeSource.raw.prepare(
      'INSERT INTO themes (name, mode, tokens, is_preset) VALUES (?, ?, ?, 0)',
    );
    themeSource.raw.transaction(() => {
      for (let index = 0; index <= BACKUP_LIMITS.themes; index += 1) {
        insertTheme.run(`Theme ${index}`, 'dark', '{}');
      }
    })();
    await expectBoundedExportRejection(
      themeSource,
      'Backup export theme count exceeds its safety bound.',
    );

    const chatSource = await createTestDb();
    const insertChat = chatSource.raw.prepare(
      'INSERT INTO chats (guid, custom_name) VALUES (?, ?)',
    );
    chatSource.raw.transaction(() => {
      for (let index = 0; index <= BACKUP_LIMITS.chatCustomizations; index += 1) {
        insertChat.run(`bounded-chat-${index}`, `Chat ${index}`);
      }
    })();
    await expectBoundedExportRejection(
      chatSource,
      'Backup export chat customization count exceeds its safety bound.',
    );
  });

  it('rejects max-plus-one participants and an over-budget bounded base payload', async () => {
    const participantSource = await createTestDb();
    await seedChat(participantSource, 'participant-bound-chat');
    await setChatCustomization(participantSource.db, 'participant-bound-chat', {
      customName: 'Participant bound',
    });
    const chat = participantSource.raw
      .prepare('SELECT id FROM chats WHERE guid = ?')
      .get('participant-bound-chat') as { id: number };
    const insertHandle = participantSource.raw.prepare(
      'INSERT INTO handles (address, service) VALUES (?, ?)',
    );
    const insertLink = participantSource.raw.prepare(
      'INSERT INTO chat_handles (chat_id, handle_id) VALUES (?, ?)',
    );
    participantSource.raw.transaction(() => {
      for (let index = 0; index <= BACKUP_LIMITS.chatParticipants; index += 1) {
        const result = insertHandle.run(`bounded-${index}@example.test`, 'iMessage');
        insertLink.run(chat.id, Number(result.lastInsertRowid));
      }
    })();
    await expectBoundedExportRejection(
      participantSource,
      'Backup export chat participant count exceeds its safety bound.',
    );

    const aggregateSource = await createTestDb();
    const maxTokens = 'x'.repeat(BACKUP_LIMITS.themeTokensCharacters);
    const insertLargeTheme = aggregateSource.raw.prepare(
      'INSERT INTO themes (name, mode, tokens, is_preset) VALUES (?, ?, ?, 0)',
    );
    aggregateSource.raw.transaction(() => {
      for (let index = 0; index < 17; index += 1) {
        insertLargeTheme.run(`Large theme ${index}`, 'dark', maxTokens);
      }
    })();
    await expectBoundedExportRejection(
      aggregateSource,
      'Backup export base data exceeds its aggregate safety bound.',
    );
  });

  it('preserves first-seen participant order when null and empty services collapse', async () => {
    const source = await createTestDb();
    await seedChat(source, 'nullable-service-duplicates', { style: 43 });
    await setChatCustomization(source.db, 'nullable-service-duplicates', {
      customName: 'Deduplicated chat',
    });
    const chat = source.raw
      .prepare('SELECT id FROM chats WHERE guid = ?')
      .get('nullable-service-duplicates') as { id: number };
    const first = source.raw
      .prepare('INSERT INTO handles (address, service) VALUES (?, NULL)')
      .run('same@example.test');
    const second = source.raw
      .prepare('INSERT INTO handles (address, service) VALUES (?, ?)')
      .run('same@example.test', '');
    const firstDistinct = source.raw
      .prepare('INSERT INTO handles (address, service) VALUES (?, ?)')
      .run('z-first@example.test', 'iMessage');
    const secondDistinct = source.raw
      .prepare('INSERT INTO handles (address, service) VALUES (?, ?)')
      .run('a-second@example.test', 'iMessage');
    source.raw
      .prepare(
        `INSERT INTO chat_handles (chat_id, handle_id)
         VALUES (?, ?), (?, ?), (?, ?), (?, ?)`,
      )
      .run(
        chat.id,
        Number(first.lastInsertRowid),
        chat.id,
        Number(second.lastInsertRowid),
        chat.id,
        Number(firstDistinct.lastInsertRowid),
        chat.id,
        Number(secondDistinct.lastInsertRowid),
      );

    const backup = await buildBackupWithCustomFolders(source.db, { exportedAt: 44 });
    expect(backup.chatCustomizations).toEqual([
      expect.objectContaining({
        identity: expect.objectContaining({
          kind: 'group',
          participants: [
            { service: '', address: 'same@example.test' },
            { service: 'iMessage', address: 'z-first@example.test' },
            { service: 'iMessage', address: 'a-second@example.test' },
          ],
        }),
      }),
    ]);
  });

  it('accounts for JSON escaping before materializing participant payloads', async () => {
    const source = await createTestDb();
    await seedChat(source, 'escaped-participant-budget');
    await setChatCustomization(source.db, 'escaped-participant-budget', {
      customName: 'Escaped participant budget',
    });
    const chat = source.raw
      .prepare('SELECT id FROM chats WHERE guid = ?')
      .get('escaped-participant-budget') as { id: number };
    const insertHandle = source.raw.prepare('INSERT INTO handles (address, service) VALUES (?, ?)');
    const insertLink = source.raw.prepare(
      'INSERT INTO chat_handles (chat_id, handle_id) VALUES (?, ?)',
    );
    source.raw.transaction(() => {
      for (let index = 0; index < BACKUP_LIMITS.chatParticipants; index += 1) {
        const suffix = `${index}@example.test`;
        const escapedAddress = '\u0001'.repeat(
          BACKUP_LIMITS.chatParticipantAddressCharacters - suffix.length,
        );
        const result = insertHandle.run(`${escapedAddress}${suffix}`, 'iMessage');
        insertLink.run(chat.id, Number(result.lastInsertRowid));
      }
    })();

    await expectBoundedExportRejection(
      source,
      'Backup export base data exceeds its aggregate safety bound.',
    );
  });

  it('rejects aggregate max-plus-one folder memberships before window or identity JSON work', async () => {
    const source = await createTestDb();
    const folders: Array<Awaited<ReturnType<typeof createCustomFolder>>> = [];
    for (let index = 0; index < 6; index += 1) {
      folders.push(await createCustomFolder(source.db, `Bounded folder ${index}`));
    }
    const insertMember = source.raw.prepare(
      'INSERT INTO custom_folder_members (folder_id, chat_guid) VALUES (?, ?)',
    );
    source.raw.transaction(() => {
      let inserted = 0;
      for (const folder of folders) {
        const folderCount = Math.min(MAX_CUSTOM_FOLDER_MEMBERS, 25_001 - inserted);
        for (let index = 0; index < folderCount; index += 1) {
          insertMember.run(folder.id, `bounded-member-${inserted + index}`);
        }
        inserted += folderCount;
      }
    })();

    const captured = captureAllSql(source.db);
    await expect(buildBackupWithCustomFolders(captured.db, { exportedAt: 44 })).rejects.toThrow(
      'Custom folder memberships exceed their aggregate backup safety bound.',
    );
    expect(captured.statements.some((statement) => /row_number\s*\(/iu.test(statement))).toBe(
      false,
    );
    expect(
      captured.statements.some(
        (statement) =>
          statement.includes('requested_chat') && statement.includes('json_group_array'),
      ),
    ).toBe(false);

    const plan = source.raw
      .prepare(
        `EXPLAIN QUERY PLAN
         WITH member_ids AS MATERIALIZED (
           SELECT rowid
             FROM custom_folder_members INDEXED BY custom_folder_members_chat_guid_idx
            ORDER BY chat_guid ASC, folder_id ASC
            LIMIT 25001
         )
         SELECT COUNT(*) FROM member_ids`,
      )
      .all() as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes('custom_folder_members_chat_guid_idx'))).toBe(
      true,
    );
    expect(plan.some((row) => row.detail.includes('USE TEMP B-TREE'))).toBe(false);
    await expect(
      kvSet(source.db, 'theme.preset', 'writer-after-folder-cap'),
    ).resolves.toBeUndefined();
  });

  it('charges escaped folder identity JSON to the shared base budget before aggregation', async () => {
    const source = await createTestDb();
    const insertTheme = source.raw.prepare(
      'INSERT INTO themes (name, mode, tokens, is_preset) VALUES (?, ?, ?, 0)',
    );
    source.raw.transaction(() => {
      for (let index = 0; index < 12; index += 1) {
        insertTheme.run(
          `Shared budget theme ${index}`,
          'dark',
          'x'.repeat(BACKUP_LIMITS.themeTokensCharacters),
        );
      }
    })();
    await seedChat(source, 'escaped-folder-budget', {
      chatIdentifier: 'escaped-folder-budget',
      style: 43,
    });
    const chat = source.raw
      .prepare('SELECT id FROM chats WHERE guid = ?')
      .get('escaped-folder-budget') as { id: number };
    const insertHandle = source.raw.prepare('INSERT INTO handles (address, service) VALUES (?, ?)');
    const insertLink = source.raw.prepare(
      'INSERT INTO chat_handles (chat_id, handle_id) VALUES (?, ?)',
    );
    source.raw.transaction(() => {
      for (let index = 0; index < 64; index += 1) {
        const suffix = `-${index}@example.test`;
        const address = `${'\u0001'.repeat(
          BACKUP_LIMITS.chatParticipantAddressCharacters - suffix.length,
        )}${suffix}`;
        const result = insertHandle.run(address, 'iMessage');
        insertLink.run(chat.id, Number(result.lastInsertRowid));
      }
    })();
    const folder = await createCustomFolder(source.db, 'Escaped identity budget');
    await replaceCustomFolderMembership(source.db, folder.id, ['escaped-folder-budget']);

    const captured = captureAllSql(source.db);
    await expect(buildBackupWithCustomFolders(captured.db, { exportedAt: 44 })).rejects.toThrow(
      'Backup export custom-folder data exceeds its aggregate safety bound.',
    );
    expect(
      captured.statements.some(
        (statement) =>
          statement.includes('requested_chat') && statement.includes('json_group_array'),
      ),
    ).toBe(false);
    await expect(
      kvSet(source.db, 'theme.preset', 'writer-after-folder-budget'),
    ).resolves.toBeUndefined();
  });

  it('preserves folder participant deduplication and first-seen order after staged reads', async () => {
    const source = await createTestDb();
    await seedChat(source, 'folder-participant-order', {
      chatIdentifier: 'folder-participant-order',
      style: 43,
    });
    const chat = source.raw
      .prepare('SELECT id FROM chats WHERE guid = ?')
      .get('folder-participant-order') as { id: number };
    const insertHandle = source.raw.prepare('INSERT INTO handles (address, service) VALUES (?, ?)');
    const insertNullService = source.raw.prepare(
      'INSERT INTO handles (address, service) VALUES (?, NULL)',
    );
    const insertLink = source.raw.prepare(
      'INSERT INTO chat_handles (chat_id, handle_id) VALUES (?, ?)',
    );
    const handleIds = [
      insertNullService.run('same@example.test').lastInsertRowid,
      insertHandle.run('same@example.test', '').lastInsertRowid,
      insertHandle.run('z-first@example.test', 'iMessage').lastInsertRowid,
      insertHandle.run('a-second@example.test', 'iMessage').lastInsertRowid,
    ];
    for (const handleId of handleIds) insertLink.run(chat.id, Number(handleId));
    const folder = await createCustomFolder(source.db, 'Participant order');
    await replaceCustomFolderMembership(source.db, folder.id, ['folder-participant-order']);

    const backup = await buildBackupWithCustomFolders(source.db, { exportedAt: 44 });
    expect(backup.customFolderChatIdentities).toEqual([
      expect.objectContaining({
        participants: [
          { service: '', address: 'same@example.test' },
          { service: 'iMessage', address: 'z-first@example.test' },
          { service: 'iMessage', address: 'a-second@example.test' },
        ],
      }),
    ]);
    expect(backup.customFolders).toEqual([
      expect.objectContaining({ sourceMemberCount: 1, memberIndexes: [0] }),
    ]);
  });

  it('exports one encrypted portable registry and restores it into a fresh database', async () => {
    const source = await createTestDb();
    await seedChat(source, 'source-guid-a', {
      chatIdentifier: 'stable-a',
      participants: [{ address: '+1 (555) 111-2222', service: 'iMessage' }],
    });
    await seedChat(source, 'source-guid-b', {
      chatIdentifier: 'stable-b',
      participants: [{ address: 'friend@example.test', service: 'iMessage' }],
    });
    // This identity is deliberately valid in SQLite but too large for the portable schema. It
    // must be counted as unavailable, not abort the complete backup.
    await seedChat(source, 'source-guid-unportable', {
      chatIdentifier: null,
      participants: [{ address: 'unportable@example.test', service: '😀'.repeat(100) }],
    });

    const trips = await createCustomFolder(source.db, 'Trips');
    const family = await createCustomFolder(source.db, 'Family');
    await setCustomFolderShowUnreadBadge(source.db, trips.id, false);
    await replaceCustomFolderMembership(source.db, trips.id, [
      'source-guid-a',
      'source-guid-unportable',
      'temporarily-absent-guid',
    ]);
    await replaceCustomFolderMembership(source.db, family.id, ['source-guid-a', 'source-guid-b']);

    const backup = await buildBackupWithCustomFolders(source.db, { exportedAt: 42 });
    expect(backup.version).toBe(3);
    expect(backup.customFolders.map((folder) => folder.name)).toEqual(['Trips', 'Family']);
    expect(backup.customFolders.map((folder) => folder.showUnreadBadge)).toEqual([0, 1]);
    expect(backup.customFolders.map((folder) => folder.sourceMemberCount)).toEqual([3, 2]);
    expect(backup.customFolderChatIdentities).toHaveLength(2);

    const indexA = backup.customFolderChatIdentities.findIndex(
      (identity) => identity.serverChatIdentifier === 'stable-a',
    );
    const indexB = backup.customFolderChatIdentities.findIndex(
      (identity) => identity.serverChatIdentifier === 'stable-b',
    );
    expect(indexA).toBeGreaterThanOrEqual(0);
    expect(indexB).toBeGreaterThanOrEqual(0);
    expect(backup.customFolders[0]!.memberIndexes).toEqual([indexA]);
    expect(new Set(backup.customFolders[1]!.memberIndexes)).toEqual(new Set([indexA, indexB]));
    expect(JSON.stringify(backup)).not.toContain('source-guid-a');
    expect(JSON.stringify(backup)).not.toContain('source-guid-unportable');

    const box = new SecretBox(await createLibsodiumBackend(), {
      opsLimit: 1,
      memLimit: 8 * 1024 * 1024,
    });
    const sealed = await sealBackup(box, backup, 'river-lantern-orbit-92');
    expect(sealed).not.toContain('Trips');
    expect(sealed).not.toContain('friend@example.test');
    const opened = await openBackup(box, sealed, 'river-lantern-orbit-92');

    const destination = await createTestDb();
    await seedChat(destination, 'destination-guid-a', {
      chatIdentifier: 'stable-a',
      participants: [{ address: '5551112222', service: 'IMESSAGE' }],
    });
    await seedChat(destination, 'destination-guid-b', {
      chatIdentifier: 'stable-b',
      participants: [{ address: 'FRIEND@example.test', service: 'imessage' }],
    });

    await expect(restoreBackup(destination.db, opened)).resolves.toEqual({
      kv: 0,
      themes: 0,
      chatCustomizations: 0,
      chatCustomizationsSkipped: 0,
      customFolders: 2,
      customFoldersSkipped: 0,
      customFolderMemberships: 3,
      customFolderMembershipsSkipped: 2,
    });
    expect(await readFolderState(destination)).toEqual([
      {
        name: 'Trips',
        sortOrder: 0,
        showUnreadBadge: 0,
        members: ['destination-guid-a'],
      },
      {
        name: 'Family',
        sortOrder: 1,
        showUnreadBadge: 1,
        members: ['destination-guid-a', 'destination-guid-b'],
      },
    ]);
  });

  it('merges exact names, preserves local-only data, and appends new folders in file order', async () => {
    const destination = await createTestDb();
    await seedChat(destination, 'target-a', { chatIdentifier: 'stable-a' });
    await seedChat(destination, 'target-b', { chatIdentifier: 'stable-b' });
    await seedChat(destination, 'local-member', { chatIdentifier: 'local-stable' });

    const trips = await createCustomFolder(destination.db, 'Trips');
    const localOnly = await createCustomFolder(destination.db, 'Local only');
    await replaceCustomFolderMembership(destination.db, trips.id, ['local-member']);
    await replaceCustomFolderMembership(destination.db, localOnly.id, ['local-member']);

    const backup: BackupV3 = {
      ...emptyV3(),
      customFolderChatIdentities: [directIdentity('stable-a'), directIdentity('stable-b')],
      customFolders: [
        { name: 'New first', showUnreadBadge: 1, sourceMemberCount: 1, memberIndexes: [1] },
        { name: 'Trips', showUnreadBadge: 0, sourceMemberCount: 1, memberIndexes: [0] },
        {
          name: 'New second',
          showUnreadBadge: 0,
          sourceMemberCount: 2,
          memberIndexes: [0, 1],
        },
      ],
    };

    await expect(restoreBackup(destination.db, backup)).resolves.toMatchObject({
      customFolders: 3,
      customFoldersSkipped: 0,
      customFolderMemberships: 4,
      customFolderMembershipsSkipped: 0,
    });
    const expected = [
      {
        name: 'Trips',
        sortOrder: 0,
        showUnreadBadge: 0,
        members: ['local-member', 'target-a'],
      },
      {
        name: 'Local only',
        sortOrder: 1,
        showUnreadBadge: 1,
        members: ['local-member'],
      },
      {
        name: 'New first',
        sortOrder: 2,
        showUnreadBadge: 1,
        members: ['target-b'],
      },
      {
        name: 'New second',
        sortOrder: 3,
        showUnreadBadge: 0,
        members: ['target-a', 'target-b'],
      },
    ];
    expect(await readFolderState(destination)).toEqual(expected);

    // A repeated restore remains a merge, not a duplicate or destructive replacement.
    await expect(restoreBackup(destination.db, backup)).resolves.toMatchObject({
      customFolders: 3,
      customFolderMemberships: 4,
    });
    expect(await readFolderState(destination)).toEqual(expected);
  });

  it('counts unavailable, ambiguous, duplicate-target, and invalid-target members as skipped', async () => {
    const destination = await createTestDb();
    await seedChat(destination, 'unique-target', { chatIdentifier: 'unique-stable' });
    await seedChat(destination, 'ambiguous-a', {
      chatIdentifier: null,
      participants: [{ address: 'shared@example.test', service: 'iMessage' }],
    });
    await seedChat(destination, 'ambiguous-b', {
      chatIdentifier: null,
      participants: [{ address: 'shared@example.test', service: 'iMessage' }],
    });
    await seedChat(destination, 'duplicate-target', { chatIdentifier: 'duplicate-stable' });
    const invalidTargetGuid = 'x'.repeat(4_097);
    await seedChat(destination, invalidTargetGuid, { chatIdentifier: 'invalid-guid-stable' });

    const backup: BackupV3 = {
      ...emptyV3(),
      customFolderChatIdentities: [
        directIdentity('unique-stable'),
        directIdentity('missing-stable'),
        directIdentity(null, [{ address: 'shared@example.test', service: 'iMessage' }]),
        directIdentity('duplicate-stable'),
        directIdentity('duplicate-stable'),
        directIdentity('invalid-guid-stable'),
      ],
      customFolders: [
        {
          name: 'Conservative',
          showUnreadBadge: 1,
          // One additional source member was unavailable when the backup was built.
          sourceMemberCount: 7,
          memberIndexes: [0, 1, 2, 3, 4, 5],
        },
      ],
    };

    await expect(restoreBackup(destination.db, backup)).resolves.toMatchObject({
      customFolders: 1,
      customFoldersSkipped: 0,
      customFolderMemberships: 1,
      customFolderMembershipsSkipped: 6,
    });
    expect((await readFolderState(destination))[0]?.members).toEqual(['unique-target']);
  });

  it('gives existing folders and members first claim on capacity', async () => {
    const destination = await createTestDb();
    await seedChat(destination, 'capacity-target-a', { chatIdentifier: 'capacity-stable-a' });
    await seedChat(destination, 'capacity-target-b', { chatIdentifier: 'capacity-stable-b' });

    const insertFolder = destination.raw.prepare(
      'INSERT INTO custom_folders (name, sort_order, show_unread_badge) VALUES (?, ?, 1)',
    );
    const insertFolders = destination.raw.transaction(() => {
      for (let i = 0; i < MAX_CUSTOM_FOLDERS; i += 1) {
        insertFolder.run(i === 0 ? 'Capacity' : `Local ${String(i).padStart(3, '0')}`, i);
      }
    });
    insertFolders();
    const capacityFolder = destination.raw
      .prepare("SELECT id FROM custom_folders WHERE name = 'Capacity'")
      .get() as { id: number };
    const insertMember = destination.raw.prepare(
      'INSERT INTO custom_folder_members (folder_id, chat_guid) VALUES (?, ?)',
    );
    const insertMembers = destination.raw.transaction(() => {
      for (let i = 0; i < MAX_CUSTOM_FOLDER_MEMBERS - 1; i += 1) {
        insertMember.run(capacityFolder.id, `local-capacity-${i}`);
      }
    });
    insertMembers();

    const backup: BackupV3 = {
      ...emptyV3(),
      customFolderChatIdentities: [
        directIdentity('capacity-stable-a'),
        directIdentity('capacity-stable-b'),
      ],
      customFolders: [
        { name: 'Capacity', showUnreadBadge: 0, sourceMemberCount: 2, memberIndexes: [0, 1] },
        { name: 'New blocked A', showUnreadBadge: 1, sourceMemberCount: 0, memberIndexes: [] },
        { name: 'New blocked B', showUnreadBadge: 1, sourceMemberCount: 0, memberIndexes: [] },
      ],
    };

    await expect(restoreBackup(destination.db, backup)).resolves.toMatchObject({
      customFolders: 1,
      customFoldersSkipped: 2,
      customFolderMemberships: 1,
      customFolderMembershipsSkipped: 1,
    });
    expect(await listCustomFolders(destination.db)).toHaveLength(MAX_CUSTOM_FOLDERS);
    const members = await listCustomFolderChatGuids(destination.db, capacityFolder.id);
    expect(members).toHaveLength(MAX_CUSTOM_FOLDER_MEMBERS);
    expect(members).toContain('capacity-target-a');
    expect(members).not.toContain('capacity-target-b');
  });

  it.each([1, 2] as const)(
    'leaves custom folders untouched when restoring backup v%d',
    async (version) => {
      const destination = await createTestDb();
      const folder = await createCustomFolder(destination.db, 'Keep me');
      await replaceCustomFolderMembership(destination.db, folder.id, ['temporarily-absent']);
      await setCustomFolderShowUnreadBadge(destination.db, folder.id, false);
      const before = await readFolderState(destination);
      const backup: Backup =
        version === 1
          ? { version, exportedAt: 1, kv: [], themes: [], chatCustomizations: [] }
          : { version, exportedAt: 1, kv: [], themes: [], chatCustomizations: [] };

      await expect(restoreBackup(destination.db, backup)).resolves.toMatchObject({
        customFolders: 0,
        customFolderMemberships: 0,
      });
      expect(await readFolderState(destination)).toEqual(before);
    },
  );

  it('rolls back every domain and cleans temporary tables after a late folder failure', async () => {
    const destination = await createTestDb();
    await kvSet(destination.db, 'theme.preset', 'before');
    await seedChat(destination, 'rollback-target', { chatIdentifier: 'rollback-stable' });
    await setChatCustomization(destination.db, 'rollback-target', { customName: 'Before' });
    const local = await createCustomFolder(destination.db, 'Local before');
    await replaceCustomFolderMembership(destination.db, local.id, ['local-member']);
    destination.raw.exec(`
      CREATE TRIGGER fail_backup_folder_member
      BEFORE INSERT ON custom_folder_members
      WHEN NEW.chat_guid = 'rollback-target'
      BEGIN
        SELECT RAISE(ABORT, 'forced folder restore failure');
      END;
    `);

    const backup: BackupV3 = {
      ...emptyV3(),
      kv: [{ key: 'theme.preset', value: 'after' }],
      themes: [{ name: 'Imported theme', mode: 'dark', tokens: '{"accent":"#123456"}' }],
      chatCustomizations: [
        {
          identity: directIdentity('rollback-stable'),
          customName: 'After',
          customColor: '#123456',
          muteType: null,
          isPinned: 0,
          pinOrder: null,
          isArchived: 0,
        },
      ],
      customFolderChatIdentities: [directIdentity('rollback-stable')],
      customFolders: [
        { name: 'Imported folder', showUnreadBadge: 1, sourceMemberCount: 1, memberIndexes: [0] },
      ],
    };

    let failure: unknown;
    try {
      await restoreBackup(destination.db, backup);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { cause?: unknown }).cause).toEqual(
      expect.objectContaining({ message: 'forced folder restore failure' }),
    );
    expect(await kvGet(destination.db, 'theme.preset')).toBe('before');
    expect(
      destination.raw.prepare("SELECT name FROM themes WHERE name = 'Imported theme'").get(),
    ).toBeUndefined();
    expect(
      destination.raw
        .prepare("SELECT custom_name AS customName FROM chats WHERE guid = 'rollback-target'")
        .get(),
    ).toEqual({ customName: 'Before' });
    expect(await readFolderState(destination)).toEqual([
      {
        name: 'Local before',
        sortOrder: 0,
        showUnreadBadge: 1,
        members: ['local-member'],
      },
    ]);
    expect(
      destination.raw
        .prepare(
          "SELECT name FROM sqlite_temp_master WHERE name LIKE 'gator_backup_restored_%' OR name = 'gator_backup_resolved_chats'",
        )
        .all(),
    ).toEqual([]);

    destination.raw.exec('DROP TRIGGER fail_backup_folder_member');
    await expect(restoreBackup(destination.db, backup)).resolves.toMatchObject({
      kv: 1,
      themes: 1,
      chatCustomizations: 1,
      customFolders: 1,
      customFolderMemberships: 1,
    });
  });
});

describe('backup v3 schema boundaries', () => {
  it.each([
    [
      'non-normalized name',
      () => ({
        ...emptyV3(),
        customFolders: [
          { name: ' Trips ', showUnreadBadge: 1, sourceMemberCount: 0, memberIndexes: [] },
        ],
      }),
    ],
    [
      'duplicate name',
      () => ({
        ...emptyV3(),
        customFolders: [
          { name: 'Trips', showUnreadBadge: 1, sourceMemberCount: 0, memberIndexes: [] },
          { name: 'Trips', showUnreadBadge: 0, sourceMemberCount: 0, memberIndexes: [] },
        ],
      }),
    ],
    [
      'invalid badge',
      () => ({
        ...emptyV3(),
        customFolders: [
          { name: 'Trips', showUnreadBadge: 2, sourceMemberCount: 0, memberIndexes: [] },
        ],
      }),
    ],
    [
      'source count below portable count',
      () => ({
        ...emptyV3(),
        customFolderChatIdentities: [directIdentity('a')],
        customFolders: [
          { name: 'Trips', showUnreadBadge: 1, sourceMemberCount: 0, memberIndexes: [0] },
        ],
      }),
    ],
    [
      'duplicate member index',
      () => ({
        ...emptyV3(),
        customFolderChatIdentities: [directIdentity('a')],
        customFolders: [
          { name: 'Trips', showUnreadBadge: 1, sourceMemberCount: 2, memberIndexes: [0, 0] },
        ],
      }),
    ],
    [
      'out-of-range member index',
      () => ({
        ...emptyV3(),
        customFolders: [
          { name: 'Trips', showUnreadBadge: 1, sourceMemberCount: 1, memberIndexes: [0] },
        ],
      }),
    ],
  ] as const)('rejects %s', (_case, build) => {
    expect(() => BackupSchema.parse(build())).toThrow();
  });

  it('enforces each new collection cap and the aggregate membership cap', () => {
    expect(() =>
      BackupSchema.parse({
        ...emptyV3(),
        customFolders: Array.from({ length: BACKUP_LIMITS.customFolders + 1 }, (_, index) => ({
          name: `Folder ${index}`,
          showUnreadBadge: 1,
          sourceMemberCount: 0,
          memberIndexes: [],
        })),
      }),
    ).toThrow();
    expect(() =>
      BackupSchema.parse({
        ...emptyV3(),
        customFolderChatIdentities: Array.from(
          { length: BACKUP_LIMITS.customFolderChatIdentities + 1 },
          (_, index) => directIdentity(`stable-${index}`),
        ),
      }),
    ).toThrow();
    expect(() =>
      BackupSchema.parse({
        ...emptyV3(),
        customFolderChatIdentities: [directIdentity('a')],
        customFolders: [
          {
            name: 'Too many members',
            showUnreadBadge: 1,
            sourceMemberCount: BACKUP_LIMITS.customFolderMembers,
            memberIndexes: Array.from({ length: BACKUP_LIMITS.customFolderMembers + 1 }, () => 0),
          },
        ],
      }),
    ).toThrow();

    const atAggregateLimit = {
      ...emptyV3(),
      customFolders: Array.from({ length: 5 }, (_, index) => ({
        name: `Full ${index}`,
        showUnreadBadge: 1,
        sourceMemberCount: BACKUP_LIMITS.customFolderMembers,
        memberIndexes: [],
      })),
    };
    expect(() => BackupSchema.parse(atAggregateLimit)).not.toThrow();
    expect(() =>
      BackupSchema.parse({
        ...atAggregateLimit,
        customFolders: [
          ...atAggregateLimit.customFolders,
          { name: 'Overflow', showUnreadBadge: 1, sourceMemberCount: 1, memberIndexes: [] },
        ],
      }),
    ).toThrow();
  });
});
