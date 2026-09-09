import { sql } from 'drizzle-orm';
import { CHUNKED_SECRET_BOX_CHUNK_BYTES, CHUNKED_SECRET_BOX_PREFIX } from '@core/crypto';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase, DbBackupRestoreWaveChecks } from '@db/types';
import { utf8Encode } from '@utils/bytes';
import { getSecretBox } from '../clients';
import { openBackup, restoreBackup, sealBackup, serializeBackup } from '../backup/backup';
import { BACKUP_LIMITS, type BackupV3 } from '../backup/backupSchema';

const PREFIX = 'gator-backup-restore-selftest';
const TARGET_PLAINTEXT_BYTES = BACKUP_LIMITS.plaintextBytes - 4 * 1024;
const PASSPHRASE = 'violet canyon lantern 7391';
const CHAT_GUID = `${PREFIX}-chat`;
const CHAT_IDENTIFIER = `${PREFIX}@example.test`;
const LOCAL_FOLDER = `${PREFIX}-local-folder`;
const IMPORTED_FOLDER = `${PREFIX}-imported-folder`;
const LOCAL_MEMBER = `${PREFIX}-local-member`;
const FAULT_TRIGGER = `${PREFIX.replaceAll('-', '_')}_fault`;
const FAULT_MESSAGE = `${PREFIX}-fault`;
const SUCCESSOR_KEY = `${PREFIX}-successor`;
const THEME_COUNT = 16;

type MutableDbBackupRestoreWaveChecks = {
  -readonly [K in keyof DbBackupRestoreWaveChecks]: DbBackupRestoreWaveChecks[K];
};

function emptyChecks(): MutableDbBackupRestoreWaveChecks {
  return {
    plaintextNearLimit: false,
    bb2Envelope: false,
    nativeSeal: false,
    nativeOpen: false,
    lateFaultObserved: false,
    kvRolledBack: false,
    themesRolledBack: false,
    chatRolledBack: false,
    foldersRolledBack: false,
    tempTablesCleaned: false,
    retrySucceeded: false,
    successorWrite: false,
  };
}

function themeTokens(length: number, seed: number): string {
  const prefix = `{"selfTest":${seed},"padding":"`;
  const suffix = '"}';
  if (length < prefix.length + suffix.length) throw new Error('invalid theme token target');
  return `${prefix}${'x'.repeat(length - prefix.length - suffix.length)}${suffix}`;
}

/** Build deterministic valid v3 content exactly 4 KiB below the accepted plaintext byte cap. */
export function buildNearLimitBackupRestoreFixture(): {
  readonly backup: BackupV3;
  readonly plaintext: string;
} {
  const themes = Array.from({ length: THEME_COUNT }, (_, index) => ({
    name: `${PREFIX}-theme-${String(index).padStart(2, '0')}`,
    mode: index % 2 === 0 ? 'dark' : 'light',
    tokens: themeTokens(BACKUP_LIMITS.themeTokensCharacters, index),
    isPreset: 0,
  }));
  const identity = {
    version: 1 as const,
    service: 'imessage',
    kind: 'direct' as const,
    serverChatIdentifier: CHAT_IDENTIFIER,
    participants: [],
  };
  const backup: BackupV3 = {
    version: 3,
    exportedAt: 1,
    appVersion: 'BACKUP-02-self-test',
    kv: [{ key: 'theme.preset', value: 'after' }],
    themes,
    chatCustomizations: [
      {
        identity,
        customName: 'After',
        customColor: '#123456',
        muteType: null,
        isPinned: 0,
        pinOrder: null,
        isArchived: 0,
      },
    ],
    customFolderChatIdentities: [identity],
    customFolders: [
      {
        name: IMPORTED_FOLDER,
        showUnreadBadge: 0,
        sourceMemberCount: 1,
        memberIndexes: [0],
      },
    ],
  };

  const oversizedLength = utf8Encode(JSON.stringify(backup)).length;
  const shrinkBy = oversizedLength - TARGET_PLAINTEXT_BYTES;
  const lastTheme = backup.themes[THEME_COUNT - 1];
  if (!lastTheme || shrinkBy <= 0 || shrinkBy >= lastTheme.tokens.length) {
    throw new Error('near-limit backup fixture cannot be sized safely');
  }
  lastTheme.tokens = themeTokens(lastTheme.tokens.length - shrinkBy, THEME_COUNT - 1);
  const plaintext = serializeBackup(backup);
  if (utf8Encode(plaintext).length !== TARGET_PLAINTEXT_BYTES) {
    throw new Error('near-limit backup fixture has an unexpected size');
  }
  return { backup, plaintext };
}

async function count(db: AppDatabase, statement: ReturnType<typeof sql>): Promise<number> {
  const rows = await db.all<{ count: number }>(statement);
  return Number(rows[0]?.count ?? 0);
}

function containsFault(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 6 && current != null && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current === 'object') {
      const candidate = current as { message?: unknown; cause?: unknown };
      if (typeof candidate.message === 'string' && candidate.message.includes(FAULT_MESSAGE)) {
        return true;
      }
      current = candidate.cause;
      continue;
    }
    break;
  }
  return false;
}

async function dropFaultTrigger(db: AppDatabase): Promise<void> {
  await withDbTransaction(db, async () => {
    await db.run(sql.raw(`DROP TRIGGER IF EXISTS temp.${FAULT_TRIGGER}`));
  });
}

async function temporaryRestoreTablesAreAbsent(db: AppDatabase): Promise<boolean> {
  return (
    (await count(
      db,
      sql`SELECT COUNT(*) AS count
            FROM sqlite_temp_master
           WHERE name LIKE 'gator_backup_restored_%'
              OR name = 'gator_backup_resolved_chats'`,
    )) === 0
  );
}

/**
 * Exercise native BB2 crypto and a late, atomic v3 restore failure on the disposable SQLCipher DB.
 * All data and credentials are fixed synthetic values; errors are reduced to finite booleans.
 */
export async function runDbBackupRestoreWave(db: AppDatabase): Promise<DbBackupRestoreWaveChecks> {
  const checks = emptyChecks();
  let triggerInstalled = false;

  try {
    const { backup, plaintext } = buildNearLimitBackupRestoreFixture();
    checks.plaintextNearLimit = utf8Encode(plaintext).length === TARGET_PLAINTEXT_BYTES;

    const box = await getSecretBox();
    const sealed = await sealBackup(box, backup, PASSPHRASE);
    checks.nativeSeal = true;
    const expectedFrames = Math.ceil(TARGET_PLAINTEXT_BYTES / CHUNKED_SECRET_BOX_CHUNK_BYTES);
    checks.bb2Envelope =
      sealed.startsWith(CHUNKED_SECRET_BOX_PREFIX) &&
      sealed.split('.').length === expectedFrames + 2 &&
      sealed.length <= BACKUP_LIMITS.encodedCharacters &&
      utf8Encode(sealed).length <= BACKUP_LIMITS.fileBytes;

    const opened = await openBackup(box, sealed, PASSPHRASE);
    checks.nativeOpen = serializeBackup(opened) === plaintext;

    await withDbTransaction(db, async () => {
      await db.run(
        sql`INSERT INTO kv (key, value) VALUES ('theme.preset', 'before')
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      );
      await db.run(
        sql`INSERT INTO themes (name, mode, tokens, is_preset)
            VALUES (${`${PREFIX}-local-theme`}, 'dark', '{"local":true}', 0)`,
      );
      await db.run(
        sql`INSERT INTO chats (guid, chat_identifier, style, custom_name)
            VALUES (${CHAT_GUID}, ${CHAT_IDENTIFIER}, 45, 'Before')`,
      );
      await db.run(
        sql`INSERT INTO custom_folders (name, sort_order, show_unread_badge)
            VALUES (${LOCAL_FOLDER}, 0, 1)`,
      );
      await db.run(
        sql`INSERT INTO custom_folder_members (folder_id, chat_guid)
            SELECT id, ${LOCAL_MEMBER} FROM custom_folders WHERE name = ${LOCAL_FOLDER}`,
      );
    });

    await withDbTransaction(db, async () => {
      await db.run(
        sql.raw(`
        CREATE TEMP TRIGGER ${FAULT_TRIGGER}
        BEFORE INSERT ON custom_folder_members
        WHEN NEW.chat_guid = '${CHAT_GUID}'
        BEGIN
          SELECT RAISE(ABORT, '${FAULT_MESSAGE}');
        END
      `),
      );
    });
    triggerInstalled = true;

    // `restoreBackup` reaches its synchronous `withDbTransaction` claim before its first await.
    // Claim the successor immediately afterward so it is ordered behind the faulting owner; the
    // host source-contract test pins that prerequisite against future restore refactors.
    const faultingRestore = restoreBackup(db, opened);
    const queuedSuccessor = withDbTransaction(db, async () => {
      await db.run(sql`INSERT INTO kv (key, value) VALUES (${SUCCESSOR_KEY}, 'committed')`);
    });
    const [restoreOutcome, successorOutcome] = await Promise.allSettled([
      faultingRestore,
      queuedSuccessor,
    ]);
    checks.lateFaultObserved =
      restoreOutcome.status === 'rejected' && containsFault(restoreOutcome.reason);
    checks.successorWrite =
      successorOutcome.status === 'fulfilled' &&
      (await count(
        db,
        sql`SELECT COUNT(*) AS count FROM kv WHERE key = ${SUCCESSOR_KEY} AND value = 'committed'`,
      )) === 1;

    checks.kvRolledBack =
      (await count(
        db,
        sql`SELECT COUNT(*) AS count FROM kv WHERE key = 'theme.preset' AND value = 'before'`,
      )) === 1;
    checks.themesRolledBack =
      (await count(
        db,
        sql`SELECT COUNT(*) AS count FROM themes WHERE name LIKE ${`${PREFIX}-theme-%`}`,
      )) === 0 &&
      (await count(
        db,
        sql`SELECT COUNT(*) AS count
              FROM themes
             WHERE name = ${`${PREFIX}-local-theme`}
               AND tokens = '{"local":true}'`,
      )) === 1;
    checks.chatRolledBack =
      (await count(
        db,
        sql`SELECT COUNT(*) AS count FROM chats WHERE guid = ${CHAT_GUID} AND custom_name = 'Before'`,
      )) === 1;
    checks.foldersRolledBack =
      (await count(
        db,
        sql`SELECT COUNT(*) AS count FROM custom_folders WHERE name = ${IMPORTED_FOLDER}`,
      )) === 0 &&
      (await count(
        db,
        sql`SELECT COUNT(*) AS count
              FROM custom_folders AS folder
              JOIN custom_folder_members AS member ON member.folder_id = folder.id
             WHERE folder.name = ${LOCAL_FOLDER}
               AND folder.sort_order = 0
               AND folder.show_unread_badge = 1
               AND member.chat_guid = ${LOCAL_MEMBER}`,
      )) === 1;
    checks.tempTablesCleaned = await temporaryRestoreTablesAreAbsent(db);

    await dropFaultTrigger(db);
    triggerInstalled = false;
    const retry = await restoreBackup(db, opened);
    const importedThemeTokenCharacters = backup.themes.reduce(
      (total, theme) => total + theme.tokens.length,
      0,
    );
    const restoredThemeRows = await db.all<{ count: number; tokenCharacters: number }>(sql`
      SELECT COUNT(*) AS count, COALESCE(SUM(length(tokens)), 0) AS tokenCharacters
        FROM themes
       WHERE name LIKE ${`${PREFIX}-theme-%`}
    `);
    checks.retrySucceeded =
      retry.kv === 1 &&
      retry.themes === THEME_COUNT &&
      retry.chatCustomizations === 1 &&
      retry.customFolders === 1 &&
      retry.customFolderMemberships === 1 &&
      (await count(
        db,
        sql`SELECT COUNT(*) AS count FROM kv WHERE key = 'theme.preset' AND value = 'after'`,
      )) === 1 &&
      Number(restoredThemeRows[0]?.count ?? 0) === THEME_COUNT &&
      Number(restoredThemeRows[0]?.tokenCharacters ?? 0) === importedThemeTokenCharacters &&
      (await count(
        db,
        sql`SELECT COUNT(*) AS count FROM chats WHERE guid = ${CHAT_GUID} AND custom_name = 'After'`,
      )) === 1 &&
      (await count(
        db,
        sql`SELECT COUNT(*) AS count
              FROM custom_folders AS folder
              JOIN custom_folder_members AS member ON member.folder_id = folder.id
             WHERE folder.name = ${IMPORTED_FOLDER}
               AND folder.show_unread_badge = 0
               AND member.chat_guid = ${CHAT_GUID}`,
      )) === 1 &&
      (await temporaryRestoreTablesAreAbsent(db));
  } catch {
    // The fixed marker booleans are the only evidence leaving this process; never retain native
    // errors because they may include a private database path or crypto implementation detail.
  } finally {
    if (triggerInstalled) {
      try {
        await dropFaultTrigger(db);
      } catch {
        // The enclosing database harness will still close and delete its fixed disposable file.
      }
    }
  }

  return checks;
}
