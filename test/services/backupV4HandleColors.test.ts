import { Chat } from '@core/models';
import {
  getBackupV4ExportData,
  setHandleColorWithinTransaction,
  upsertChats,
  upsertHandles,
  MAX_CUSTOM_FOLDER_MEMBERSHIPS_TOTAL,
  type BackupExportLimits,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import { buildBackupWithCustomFolders, restoreBackup } from '@/services/backup/backup';
import {
  BACKUP_LIMITS,
  BackupV4Schema,
  type BackupV3,
  type BackupV4,
} from '@/services/backup/backupSchema';
import { createTestDb } from '../support/testDb';

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const ADDRESS = '+15550001111';

function exportLimits(overrides: Partial<BackupExportLimits> = {}): BackupExportLimits {
  return {
    kvKeys: [],
    maxRawBytes: BACKUP_LIMITS.plaintextBytes,
    kvEntries: BACKUP_LIMITS.kvEntries,
    themes: BACKUP_LIMITS.themes,
    chatCustomizations: BACKUP_LIMITS.chatCustomizations,
    handleColors: BACKUP_LIMITS.handleColors,
    keyCharacters: BACKUP_LIMITS.keyCharacters,
    valueCharacters: BACKUP_LIMITS.valueCharacters,
    themeNameCharacters: BACKUP_LIMITS.themeNameCharacters,
    themeModeCharacters: BACKUP_LIMITS.themeModeCharacters,
    themeTokensCharacters: BACKUP_LIMITS.themeTokensCharacters,
    chatGuidCharacters: BACKUP_LIMITS.chatGuidCharacters,
    chatServiceCharacters: BACKUP_LIMITS.chatServiceCharacters,
    chatIdentifierCharacters: BACKUP_LIMITS.chatIdentifierCharacters,
    chatParticipantAddressCharacters: BACKUP_LIMITS.chatParticipantAddressCharacters,
    chatParticipants: BACKUP_LIMITS.chatParticipants,
    customFolderChatIdentities: BACKUP_LIMITS.customFolderChatIdentities,
    customFolderMemberships: BACKUP_LIMITS.customFolderMemberships,
    chatNameCharacters: BACKUP_LIMITS.chatNameCharacters,
    chatColorCharacters: BACKUP_LIMITS.chatColorCharacters,
    muteTypeCharacters: BACKUP_LIMITS.muteTypeCharacters,
    ...overrides,
  };
}

function emptyV4(handleColors: BackupV4['handleColors'] = []): BackupV4 {
  return {
    version: 4,
    exportedAt: 1,
    kv: [],
    themes: [],
    chatCustomizations: [],
    customFolderChatIdentities: [],
    customFolders: [],
    handleColors,
  };
}

async function seedColoredHandle(
  testDb: TestDb,
  guid: string,
  service: string,
  color: string,
): Promise<void> {
  const participant = { address: ADDRESS, service };
  const handles = await upsertHandles(testDb.db, [participant]);
  await upsertChats(
    testDb.db,
    [Chat.parse({ guid, style: 45, participants: [participant] })],
    handles,
  );
  await withDbTransaction(testDb.db, (context) =>
    setHandleColorWithinTransaction(context, guid, ADDRESS, service, color),
  );
}

function storedColors(testDb: TestDb): {
  address: string;
  service: string;
  color: string | null;
}[] {
  return testDb.raw
    .prepare(
      `SELECT address, service, color
         FROM handles
        ORDER BY id`,
    )
    .all() as { address: string; service: string; color: string | null }[];
}

describe('backup v4 device-owned handle colors', () => {
  it('exports canonical non-null colors per exact service identity', async () => {
    const source = await createTestDb();
    await seedColoredHandle(source, `iMessage;-;${ADDRESS}`, 'iMessage', ' #abcdef ');
    await seedColoredHandle(source, `SMS;-;${ADDRESS}`, 'SMS', '#123456');
    await upsertHandles(source.db, [{ address: 'uncolored@example.test', service: 'iMessage' }]);

    const backup = await buildBackupWithCustomFolders(source.db, { exportedAt: 42 });

    expect(backup.version).toBe(4);
    expect(backup.handleColors).toEqual([
      { address: ADDRESS, service: 'iMessage', color: '#ABCDEF' },
      { address: ADDRESS, service: 'SMS', color: '#123456' },
    ]);
  });

  it('restores placeholder rows and later sync upserts cannot overwrite their colors', async () => {
    const destination = await createTestDb();
    const backup = emptyV4([
      { address: ADDRESS, service: 'iMessage', color: '#ABCDEF' },
      { address: ADDRESS, service: 'SMS', color: '#123456' },
    ]);

    await expect(restoreBackup(destination.db, backup)).resolves.toMatchObject({
      handleColors: 2,
      handleColorsSkipped: 0,
    });
    expect(storedColors(destination)).toEqual(backup.handleColors);

    await upsertHandles(destination.db, [
      {
        address: ADDRESS,
        service: 'iMessage',
        originalROWID: 71,
        country: 'US',
        color: '#654321',
        displayName: 'Alice',
      },
      {
        address: ADDRESS,
        service: 'SMS',
        originalROWID: 72,
        country: 'CA',
        color: null,
        displayName: 'Alice SMS',
      },
    ]);
    expect(storedColors(destination)).toEqual(backup.handleColors);
    expect(
      destination.raw
        .prepare(
          `SELECT original_row_id AS originalRowId, country
             FROM handles
            ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { originalRowId: 71, country: 'US' },
      { originalRowId: 72, country: 'CA' },
    ]);
  });

  it('restoring a v3 backup leaves an existing local color unchanged', async () => {
    const destination = await createTestDb();
    await seedColoredHandle(destination, `iMessage;-;${ADDRESS}`, 'iMessage', '#ABCDEF');
    const backup: BackupV3 = {
      version: 3,
      exportedAt: 1,
      kv: [],
      themes: [],
      chatCustomizations: [],
      customFolderChatIdentities: [],
      customFolders: [],
    };

    await expect(restoreBackup(destination.db, backup)).resolves.toMatchObject({
      handleColors: 0,
      handleColorsSkipped: 0,
    });
    expect(storedColors(destination)).toEqual([
      { address: ADDRESS, service: 'iMessage', color: '#ABCDEF' },
    ]);
  });

  it('rejects duplicate identities and non-canonical colors', () => {
    expect(() =>
      BackupV4Schema.parse(
        emptyV4([
          { address: ADDRESS, service: 'iMessage', color: '#ABCDEF' },
          { address: ADDRESS, service: 'iMessage', color: '#123456' },
        ]),
      ),
    ).toThrow(/unique/i);
    expect(() =>
      BackupV4Schema.parse(emptyV4([{ address: ADDRESS, service: 'iMessage', color: '#abcdef' }])),
    ).toThrow();
    expect(() =>
      BackupV4Schema.parse(emptyV4([{ address: ADDRESS, service: 'iMessage', color: 'blue' }])),
    ).toThrow();
  });

  it('rejects max-plus-one colored rows before exporting them', async () => {
    const source = await createTestDb();
    source.raw.exec(`
      WITH digits(value) AS (
        VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
      ), numbers(value) AS (
        SELECT ones.value
             + tens.value * 10
             + hundreds.value * 100
             + thousands.value * 1000
             + ten_thousands.value * 10000
          FROM digits AS ones
          CROSS JOIN digits AS tens
          CROSS JOIN digits AS hundreds
          CROSS JOIN digits AS thousands
          CROSS JOIN digits AS ten_thousands
      )
      INSERT INTO handles (address, service, color)
      SELECT 'person-' || value || '@example.test', 'iMessage', '#ABCDEF'
        FROM numbers
       WHERE value <= ${BACKUP_LIMITS.handleColors}
       ORDER BY value
    `);

    await expect(buildBackupWithCustomFolders(source.db, { exportedAt: 42 })).rejects.toThrow(
      'Handle-color count exceeds its backup safety bound.',
    );
    await expect(
      upsertHandles(source.db, [{ address: 'writer-after-rejection', service: 'iMessage' }]),
    ).resolves.toBeInstanceOf(Map);
  });

  it('charges JSON escaping before materializing handle-color rows', async () => {
    const source = await createTestDb();
    const address = '"\\\n'.repeat(40);
    source.raw
      .prepare('INSERT INTO handles (address, service, color) VALUES (?, ?, ?)')
      .run(address, 'iMessage', '#ABCDEF');

    const maxRawBytes = 200;
    const limits = exportLimits({ maxRawBytes });
    expect(Buffer.byteLength(address + 'iMessage#ABCDEF')).toBeLessThan(maxRawBytes);
    expect(
      Buffer.byteLength(JSON.stringify([{ address, service: 'iMessage', color: '#ABCDEF' }])),
    ).toBeGreaterThan(maxRawBytes);

    await expect(getBackupV4ExportData(source.db, limits)).rejects.toThrow(
      'Backup export handle-color data exceeds its aggregate safety bound.',
    );
  });

  it('rejects oversized handle text before asking SQLite to materialize its JSON', async () => {
    const source = await createTestDb();
    source.raw
      .prepare('INSERT INTO handles (address, service, color) VALUES (?, ?, ?)')
      .run('x'.repeat(BACKUP_LIMITS.chatParticipantAddressCharacters + 1), 'iMessage', '#ABCDEF');
    let jsonObjectCalls = 0;
    source.raw.function('json_object', { varargs: true }, () => {
      jsonObjectCalls += 1;
      throw new Error('oversized handle reached json_object');
    });

    await expect(getBackupV4ExportData(source.db, exportLimits())).rejects.toThrow(
      'Backup export handle color address exceeds its safety bound.',
    );
    expect(jsonObjectCalls).toBe(0);
  });

  it('rolls back restored placeholder rows when the account guard is revoked before commit', async () => {
    const destination = await createTestDb();
    let current = true;
    destination.raw.function('revoke_handle_color_restore', () => {
      current = false;
      return 1;
    });
    destination.raw.exec(`
      CREATE TRIGGER revoke_handle_color_restore
      AFTER INSERT ON handles
      BEGIN
        SELECT revoke_handle_color_restore();
      END
    `);

    await expect(
      restoreBackup(
        destination.db,
        emptyV4([{ address: ADDRESS, service: 'iMessage', color: '#ABCDEF' }]),
        () => current,
      ),
    ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    expect(storedColors(destination)).toEqual([]);
  });
});

// The export reads its folder caps from the passed limits now, so pin the one relationship the
// removed repository constant used to encode (review M074).
it('caps backup folder memberships at the same total that saving folders enforces', () => {
  expect(BACKUP_LIMITS.customFolderMemberships).toBe(MAX_CUSTOM_FOLDER_MEMBERSHIPS_TOTAL);
});
