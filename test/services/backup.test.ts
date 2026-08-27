import { Chat } from '@core/models';
import {
  kvSet,
  restoreThemes,
  setChatCustomization,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import {
  CHUNKED_SECRET_BOX_CHUNK_BYTES,
  CHUNKED_SECRET_BOX_PREFIX,
  CRYPTO_SIZES,
  encodeEnvelope,
  SECRET_BOX_AEAD_TAG_BYTES,
  SecretBox,
  type CryptoBackend,
} from '@core/crypto';
import { fromBase64, toBase64 } from '@utils/bytes';
import {
  BackupInputLimitError,
  buildBackup,
  openBackup,
  parseBackup,
  restoreBackup,
  sealBackup,
} from '@/services/backup/backup';
import {
  BACKUP_LIMITS,
  BackupSchema,
  getNewBackupPassphraseIssue,
  isBackupKey,
  isSecretKey,
  looksEncrypted,
  MIN_NEW_BACKUP_PASSPHRASE_LENGTH,
  type Backup,
} from '@/services/backup/backupSchema';
import { createLibsodiumBackend } from '../support/libsodiumBackend';
import { createTestDb } from '../support/testDb';

type Db = Awaited<ReturnType<typeof createTestDb>>;

async function seedChat(t: Db, guid: string): Promise<void> {
  const handles = await upsertHandles(t.db, [{ address: 'a@b.com' }]);
  await upsertChats(
    t.db,
    [
      Chat.parse({
        guid,
        displayName: 'Server',
        style: 43,
        participants: [{ address: 'a@b.com' }],
      }),
    ],
    handles,
  );
}

describe('isSecretKey', () => {
  it('flags credential-like keys, not ordinary prefs', () => {
    expect(isSecretKey('server.password')).toBe(true);
    expect(isSecretKey('authToken')).toBe(true);
    expect(isSecretKey('db.encryption_key')).toBe(true);
    expect(isSecretKey('guidAuthKey')).toBe(true);
    expect(isSecretKey('apiKey')).toBe(true); // camelCase caught
    expect(isSecretKey('serverApiKey')).toBe(true);
    expect(isSecretKey('theme.preset')).toBe(false);
    expect(isSecretKey('app.lock.timeout')).toBe(false);
  });
});

describe('isBackupKey (the export ALLOW-list)', () => {
  it('admits settings and nothing else', () => {
    expect(isBackupKey('theme.preset')).toBe(true);
    // Retired settings stay rejected so an old backup cannot bring removed behavior back.
    expect(isBackupKey('privacy.redactedMode')).toBe(false);
    expect(isBackupKey('attachments.autoDownloadDestination')).toBe(true);
    expect(isBackupKey('downloads.maxConcurrent')).toBe(true);
    // Consent must be granted on this device, not silently restored onto a fresh install.
    expect(isBackupKey('diagnostics.errorReporting')).toBe(false);
    expect(isBackupKey('diagnostics.errorReportingConsent.v1')).toBe(false);
    // Unsent message text keyed by the counterparty's address — content, not a setting.
    expect(isBackupKey('draft.iMessage;-;+15555550123')).toBe(false);
    // Device-local bookkeeping: carrying these between installs corrupts the target's state.
    expect(isBackupKey('sync.deletionsSyncedAt')).toBe(false);
    expect(isBackupKey('maintenance.searchTextBackfill.v1')).toBe(false);
    // A row id, meaningless on any other device.
    expect(isBackupKey('theme.custom')).toBe(false);
    // Unknown/future keys are excluded by default — the point of inverting the filter.
    expect(isBackupKey('some.newSetting')).toBe(false);
  });
});

describe('buildBackup', () => {
  it('gathers kv + themes + chat customizations', async () => {
    const t = await createTestDb();
    await kvSet(t.db, 'theme.preset', 'oledDark');
    t.raw
      .prepare('INSERT INTO themes (name, mode, tokens, is_preset) VALUES (?,?,?,0)')
      .run('Mine', 'dark', '{"x":1}');
    await seedChat(t, 'c1');
    await setChatCustomization(t.db, 'c1', { customName: 'Best', customColor: '#34C759' });

    const b = await buildBackup(t.db, { exportedAt: 123, appVersion: '1.0.0' });
    expect(b.version).toBe(1);
    expect(b.exportedAt).toBe(123);
    expect(b.kv).toContainEqual({ key: 'theme.preset', value: 'oledDark' });
    expect(b.themes).toContainEqual(
      expect.objectContaining({ name: 'Mine', mode: 'dark', tokens: '{"x":1}' }),
    );
    expect(b.chatCustomizations).toContainEqual(
      expect.objectContaining({ guid: 'c1', customName: 'Best', customColor: '#34C759' }),
    );
  });

  it('NEVER exports secret-looking kv keys (security guard)', async () => {
    const t = await createTestDb();
    await kvSet(t.db, 'theme.preset', 'nord');
    await kvSet(t.db, 'server.password', 'hunter2');
    await kvSet(t.db, 'guidAuthKey', 'deadbeef');

    const b = await buildBackup(t.db, { exportedAt: 1 });
    const keys = b.kv.map((p) => p.key);
    expect(keys).toContain('theme.preset');
    expect(keys).not.toContain('server.password');
    expect(keys).not.toContain('guidAuthKey');
    expect(b.kv.every((p) => !isSecretKey(p.key))).toBe(true);
  });

  it('NEVER exports retired settings, composer drafts, or device-local sync state', async () => {
    const t = await createTestDb();
    await kvSet(t.db, 'theme.preset', 'nord');
    await kvSet(t.db, 'privacy.redactedMode', '1');
    // A draft key embeds the counterparty's address and the value is unsent message text.
    await kvSet(t.db, 'draft.iMessage;-;+15555550123', 'meet me at 4');
    // Watermarks/flags that describe THIS install, not the user's preferences.
    await kvSet(t.db, 'sync.deletionsSyncedAt', '1900000000000');
    await kvSet(t.db, 'maintenance.searchTextBackfill.v1', 'done');
    await kvSet(t.db, 'theme.custom', '7');

    const keys = (await buildBackup(t.db, { exportedAt: 1 })).kv.map((p) => p.key);
    expect(keys).toEqual(['theme.preset']);
  });
});

describe('restoreBackup round-trip', () => {
  it('rebuilds kv/themes/chat customizations into a fresh db', async () => {
    const src = await createTestDb();
    await kvSet(src.db, 'theme.preset', 'brightWhite');
    src.raw
      .prepare('INSERT INTO themes (name, mode, tokens, is_preset) VALUES (?,?,?,0)')
      .run('Custom', 'light', '{"a":2}');
    await seedChat(src, 'c1');
    await setChatCustomization(src.db, 'c1', { customName: 'Squad', customColor: '#AF52DE' });
    const backup = await buildBackup(src.db, { exportedAt: 9 });

    // Restore into a fresh db that already has chat c1 (customizations apply by guid).
    const dst = await createTestDb();
    await seedChat(dst, 'c1');
    const res = await restoreBackup(dst.db, backup);
    expect(res.chatCustomizations).toBe(1);

    const theme = dst.raw.prepare("SELECT mode FROM themes WHERE name='Custom'").get() as {
      mode: string;
    };
    expect(theme.mode).toBe('light');
    const kv = dst.raw.prepare("SELECT value FROM kv WHERE key='theme.preset'").get() as {
      value: string;
    };
    expect(kv.value).toBe('brightWhite');
    const chat = dst.raw.prepare("SELECT custom_name FROM chats WHERE guid='c1'").get() as {
      custom_name: string;
    };
    expect(chat.custom_name).toBe('Squad');
  });

  it('queues theme restore behind a rolling-back neighbour instead of joining it', async () => {
    const t = await createTestDb();
    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(t.db, async () => {
      t.raw
        .prepare('INSERT INTO themes (name, mode, tokens, is_preset) VALUES (?,?,?,0)')
        .run('Mine', 'dark', '{"phantom":1}');
      neighbourStarted();
      await release;
      throw new Error('neighbour rollback');
    });
    await started;

    const restore = restoreThemes(t.db, [
      { name: 'Mine', mode: 'dark', tokens: '{"safe":1}', isPreset: 0 },
    ]);
    await Promise.resolve();
    expect(t.raw.prepare("SELECT tokens FROM themes WHERE name='Mine'").get()).toEqual({
      tokens: '{"phantom":1}',
    });

    releaseNeighbour();
    await expect(neighbour).rejects.toThrow('neighbour rollback');
    await restore;
    expect(t.raw.prepare("SELECT tokens FROM themes WHERE name='Mine'").get()).toEqual({
      tokens: '{"safe":1}',
    });
  });

  it('ignores retired keys and rolls back every KV row when ownership is revoked', async () => {
    const t = await createTestDb();
    let current = true;
    t.raw.function('revoke_backup_during_kv_restore', () => {
      current = false;
      return 0;
    });
    t.raw.exec(`
      CREATE TRIGGER revoke_backup_on_supported_setting
      AFTER INSERT ON kv
      WHEN NEW.key = 'downloads.maxConcurrent'
      BEGIN
        SELECT revoke_backup_during_kv_restore();
      END
    `);

    await expect(
      restoreBackup(
        t.db,
        {
          version: 1,
          exportedAt: 1,
          kv: [
            { key: 'theme.preset', value: 'nord' },
            { key: 'privacy.redactedMode', value: '1' },
            { key: 'downloads.maxConcurrent', value: '3' },
          ],
          themes: [{ name: 'must-not-run', mode: 'dark', tokens: '{}', isPreset: 0 }],
          chatCustomizations: [],
        },
        () => current,
      ),
    ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);

    expect(t.raw.prepare('SELECT key, value FROM kv ORDER BY key').all()).toEqual([]);
    expect(t.raw.prepare('SELECT name FROM themes').all()).toEqual([]);
  });

  it('rolls back KV and every theme when a later theme write fails', async () => {
    const t = await createTestDb();
    t.raw.exec(`
      CREATE TRIGGER fail_backup_on_second_theme
      BEFORE INSERT ON themes
      WHEN NEW.name = 'revoke-here'
      BEGIN
        SELECT RAISE(ABORT, 'simulated backup restore failure');
      END
    `);

    let failure: unknown;
    try {
      await restoreBackup(t.db, {
        version: 1,
        exportedAt: 1,
        kv: [{ key: 'theme.preset', value: 'nord' }],
        themes: [
          { name: 'committed-prefix', mode: 'dark', tokens: '{"a":1}', isPreset: 0 },
          { name: 'revoke-here', mode: 'dark', tokens: '{"b":2}', isPreset: 0 },
          { name: 'must-not-run', mode: 'dark', tokens: '{"c":3}', isPreset: 0 },
        ],
        chatCustomizations: [],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { cause?: unknown }).cause).toEqual(
      expect.objectContaining({ message: 'simulated backup restore failure' }),
    );

    expect(t.raw.prepare('SELECT name, tokens FROM themes ORDER BY id').all()).toEqual([]);
    expect(t.raw.prepare("SELECT value FROM kv WHERE key = 'theme.preset'").get()).toBeUndefined();
  });

  it('tracks duplicate-theme cursors per name and mode when identities are interleaved', async () => {
    const t = await createTestDb();
    const insert = t.raw.prepare(
      'INSERT INTO themes (name, mode, tokens, is_preset) VALUES (?,?,?,0)',
    );
    insert.run('A', 'dark', '{"oldA1":1}');
    insert.run('B', 'light', '{"oldB":1}');
    insert.run('A', 'dark', '{"oldA2":1}');

    await restoreThemes(t.db, [
      { name: 'A', mode: 'dark', tokens: '{"newA1":1}', isPreset: 0 },
      { name: 'A', mode: 'dark', tokens: '{"newA2":1}', isPreset: 0 },
      { name: 'B', mode: 'light', tokens: '{"newB":1}', isPreset: 0 },
    ]);

    expect(t.raw.prepare('SELECT id, tokens FROM themes ORDER BY id').all()).toEqual([
      { id: 1, tokens: '{"newA1":1}' },
      { id: 2, tokens: '{"newB":1}' },
      { id: 3, tokens: '{"newA2":1}' },
    ]);
  });

  it('does not claim a same-name theme created after the restore cutoff', async () => {
    const t = await createTestDb();
    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(t.db, async () => {
      neighbourStarted();
      await release;
    });
    await started;

    // restoreThemes claims its cutoff queue slot synchronously. This editor write queues after the
    // cutoff but before the restore's per-item transaction.
    const restore = restoreThemes(t.db, [
      { name: 'Mine', mode: 'dark', tokens: '{"backup":1}', isPreset: 0 },
    ]);
    const editorInsert = withDbTransaction(t.db, async () => {
      t.raw
        .prepare('INSERT INTO themes (name, mode, tokens, is_preset) VALUES (?,?,?,0)')
        .run('Mine', 'dark', '{"editor":1}');
    });

    releaseNeighbour();
    await neighbour;
    await editorInsert;
    await restore;
    expect(t.raw.prepare("SELECT tokens FROM themes WHERE name='Mine' ORDER BY id").all()).toEqual([
      { tokens: '{"editor":1}' },
      { tokens: '{"backup":1}' },
    ]);
  });

  it('restoring the SAME backup twice does not duplicate themes (upsert, not insert)', async () => {
    const src = await createTestDb();
    src.raw
      .prepare('INSERT INTO themes (name, mode, tokens, is_preset) VALUES (?,?,?,0)')
      .run('Mine', 'dark', '{"a":1}');
    const backup = await buildBackup(src.db, { exportedAt: 1 });

    const dst = await createTestDb();
    await restoreBackup(dst.db, backup);
    await restoreBackup(dst.db, backup); // a second recovery attempt — an utterly normal action
    const rows = dst.raw.prepare("SELECT tokens FROM themes WHERE name='Mine'").all() as {
      tokens: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokens).toBe('{"a":1}');
  });

  it('a restore REFRESHES an existing theme of the same name+mode instead of adding a twin', async () => {
    const t = await createTestDb();
    t.raw
      .prepare('INSERT INTO themes (name, mode, tokens, is_preset) VALUES (?,?,?,0)')
      .run('Mine', 'dark', '{"old":1}');
    const id = (t.raw.prepare("SELECT id FROM themes WHERE name='Mine'").get() as { id: number })
      .id;

    await restoreBackup(t.db, {
      version: 1,
      exportedAt: 1,
      kv: [],
      themes: [{ name: 'Mine', mode: 'dark', tokens: '{"new":2}', isPreset: 0 }],
      chatCustomizations: [],
    });

    const rows = t.raw.prepare("SELECT id, tokens FROM themes WHERE name='Mine'").all() as {
      id: number;
      tokens: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokens).toBe('{"new":2}');
    // Same row id: the theme is updated in place, never deleted-and-recreated, so a kv pointer at
    // the active custom theme (and the reactive theme list) never sees it missing.
    expect(rows[0]?.id).toBe(id);
  });

  it('same name in a different mode is a DIFFERENT theme (the key is name + mode)', async () => {
    const t = await createTestDb();
    await restoreBackup(t.db, {
      version: 1,
      exportedAt: 1,
      kv: [],
      themes: [
        { name: 'Mine', mode: 'dark', tokens: '{"d":1}', isPreset: 0 },
        { name: 'Mine', mode: 'light', tokens: '{"l":1}', isPreset: 0 },
      ],
      chatCustomizations: [],
    });
    const rows = t.raw.prepare("SELECT mode FROM themes WHERE name='Mine' ORDER BY mode").all();
    expect(rows).toEqual([{ mode: 'dark' }, { mode: 'light' }]);
  });

  it('never touches a built-in preset row that happens to share a name', async () => {
    const t = await createTestDb();
    t.raw
      .prepare('INSERT INTO themes (name, mode, tokens, is_preset) VALUES (?,?,?,1)')
      .run('Mine', 'dark', '{"preset":1}');
    await restoreBackup(t.db, {
      version: 1,
      exportedAt: 1,
      kv: [],
      themes: [{ name: 'Mine', mode: 'dark', tokens: '{"user":1}', isPreset: 0 }],
      chatCustomizations: [],
    });
    const rows = t.raw
      .prepare("SELECT tokens, is_preset FROM themes WHERE name='Mine' ORDER BY is_preset")
      .all() as { tokens: string; is_preset: number }[];
    expect(rows).toEqual([
      { tokens: '{"user":1}', is_preset: 0 },
      { tokens: '{"preset":1}', is_preset: 1 },
    ]);
  });

  it('restores TWIN themes (same name + mode) one-for-one instead of collapsing them', async () => {
    // The editor seeds every new theme's name to 'My Theme', so two hand-built palettes sharing a
    // (name, mode) is the ordinary case. `themes` has no unique index, so both rows are legal.
    const src = await createTestDb();
    const ins = src.raw.prepare(
      'INSERT INTO themes (name, mode, tokens, is_preset) VALUES (?,?,?,0)',
    );
    ins.run('My Theme', 'dark', '{"a":1}');
    ins.run('My Theme', 'dark', '{"b":2}');
    const backup = await buildBackup(src.db, { exportedAt: 1 });

    // Fresh device (the primary use of a backup): BOTH palettes must land, not one.
    const dst = await createTestDb();
    await restoreBackup(dst.db, backup);
    const after = (): unknown[] => dst.raw.prepare('SELECT tokens FROM themes ORDER BY id').all();
    expect(after()).toEqual([{ tokens: '{"a":1}' }, { tokens: '{"b":2}' }]);

    // A second recovery attempt pairs 1:1 with the rows it just created — no twins multiply.
    await restoreBackup(dst.db, backup);
    expect(after()).toEqual([{ tokens: '{"a":1}' }, { tokens: '{"b":2}' }]);
  });

  it('a restore onto the SOURCE device leaves each twin its own palette', async () => {
    const t = await createTestDb();
    const ins = t.raw.prepare(
      'INSERT INTO themes (name, mode, tokens, is_preset) VALUES (?,?,?,0)',
    );
    ins.run('My Theme', 'dark', '{"a":1}');
    ins.run('My Theme', 'dark', '{"b":2}');
    const backup = await buildBackup(t.db, { exportedAt: 1 });

    await restoreBackup(t.db, backup);
    // Same ids, each with the tokens it was exported with — a hand-built palette is never
    // overwritten by its twin's.
    expect(t.raw.prepare('SELECT id, tokens FROM themes ORDER BY id').all()).toEqual([
      { id: 1, tokens: '{"a":1}' },
      { id: 2, tokens: '{"b":2}' },
    ]);
  });

  it('leaves a local twin the backup does not account for untouched', async () => {
    const t = await createTestDb();
    const ins = t.raw.prepare(
      'INSERT INTO themes (name, mode, tokens, is_preset) VALUES (?,?,?,0)',
    );
    ins.run('My Theme', 'dark', '{"local1":1}');
    ins.run('My Theme', 'dark', '{"local2":1}');

    await restoreBackup(t.db, {
      version: 1,
      exportedAt: 1,
      kv: [],
      themes: [{ name: 'My Theme', mode: 'dark', tokens: '{"fromBackup":1}', isPreset: 0 }],
      chatCustomizations: [],
    });
    expect(t.raw.prepare('SELECT tokens FROM themes ORDER BY id').all()).toEqual([
      { tokens: '{"fromBackup":1}' },
      { tokens: '{"local2":1}' },
    ]);
  });

  it('a backup file cannot plant a draft or move this device’s deletion watermark', async () => {
    const dst = await createTestDb();
    await kvSet(dst.db, 'sync.deletionsSyncedAt', '1000000000000');
    await kvSet(dst.db, 'draft.iMessage;-;+15555550123', 'my current draft');

    // A hand-edited / foreign file: the import-side allow-list is what stops it.
    const res = await restoreBackup(dst.db, {
      version: 1,
      exportedAt: 1,
      kv: [
        { key: 'theme.preset', value: 'nord' },
        { key: 'sync.deletionsSyncedAt', value: '1900000000000' },
        { key: 'draft.iMessage;-;+15555550123', value: 'someone else’s text' },
      ],
      themes: [],
      chatCustomizations: [],
    });
    expect(res.kv).toBe(1);
    const read = (key: string): string | undefined =>
      (
        dst.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
          { value: string } | undefined
      )?.value;
    expect(read('theme.preset')).toBe('nord');
    // A watermark dragged forward would make the deletion catch-up sync skip its window for good.
    expect(read('sync.deletionsSyncedAt')).toBe('1000000000000');
    expect(read('draft.iMessage;-;+15555550123')).toBe('my current draft');
  });

  it('does not resurrect a conversation deleted on THIS device', async () => {
    const src = await createTestDb();
    await seedChat(src, 'c1');
    await setChatCustomization(src.db, 'c1', { customName: 'Squad' });
    const backup = await buildBackup(src.db, { exportedAt: 1 });

    const dst = await createTestDb();
    await seedChat(dst, 'c1');
    dst.raw.prepare("UPDATE chats SET deleted_at = 5000 WHERE guid = 'c1'").run();

    await restoreBackup(dst.db, backup);
    expect(
      dst.raw
        .prepare("SELECT custom_name, deleted_at, marked_unread_at FROM chats WHERE guid = 'c1'")
        .get(),
    ).toEqual({ custom_name: 'Squad', deleted_at: 5000, marked_unread_at: null });
  });

  it('never carries a tombstone or an unread mark across devices', async () => {
    const src = await createTestDb();
    await seedChat(src, 'c1');
    await setChatCustomization(src.db, 'c1', { customName: 'Squad' });
    src.raw
      .prepare("UPDATE chats SET deleted_at = 9000, marked_unread_at = 9000 WHERE guid = 'c1'")
      .run();
    const backup = await buildBackup(src.db, { exportedAt: 1 });
    // Both columns are per-device state and are not even in the file.
    expect(backup.chatCustomizations[0]).not.toHaveProperty('deletedAt');
    expect(backup.chatCustomizations[0]).not.toHaveProperty('markedUnreadAt');

    const dst = await createTestDb();
    await seedChat(dst, 'c1');
    await restoreBackup(dst.db, backup);
    // The live conversation stays live and unbadged; only the customization travels.
    expect(
      dst.raw
        .prepare("SELECT custom_name, deleted_at, marked_unread_at FROM chats WHERE guid = 'c1'")
        .get(),
    ).toEqual({ custom_name: 'Squad', deleted_at: null, marked_unread_at: null });
  });

  it('does not apply customizations to chats that do not exist locally', async () => {
    const t = await createTestDb();
    const res = await restoreBackup(t.db, {
      version: 1,
      exportedAt: 1,
      kv: [],
      themes: [],
      chatCustomizations: [
        {
          guid: 'missing',
          customName: 'X',
          customColor: null,
          muteType: null,
          isPinned: 0,
          isArchived: 0,
        },
      ],
    });
    expect(res.chatCustomizations).toBe(0);
  });

  it('queues an ordinary customization restore behind a rolling-back neighbour', async () => {
    const t = await createTestDb();
    await seedChat(t, 'cQueued');
    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(t.db, async () => {
      t.raw.prepare("UPDATE chats SET custom_name = 'phantom' WHERE guid = 'cQueued'").run();
      neighbourStarted();
      await release;
      throw new Error('neighbour rollback');
    });
    await started;

    const restoring = restoreBackup(t.db, {
      version: 1,
      exportedAt: 1,
      kv: [],
      themes: [],
      chatCustomizations: [
        {
          guid: 'cQueued',
          customName: 'restored safely',
          customColor: null,
          muteType: null,
          isPinned: 0,
          isArchived: 0,
        },
      ],
    });
    await Promise.resolve();
    expect(t.raw.prepare("SELECT custom_name FROM chats WHERE guid = 'cQueued'").get()).toEqual({
      custom_name: 'phantom',
    });

    releaseNeighbour();
    await expect(neighbour).rejects.toThrow('neighbour rollback');
    await expect(restoring).resolves.toMatchObject({ chatCustomizations: 1 });
    expect(t.raw.prepare("SELECT custom_name FROM chats WHERE guid = 'cQueued'").get()).toEqual({
      custom_name: 'restored safely',
    });
  });

  it('rolls back KV, themes, and chat changes when ownership changes during chat apply', async () => {
    const t = await createTestDb();
    await seedChat(t, 'iMessage;-;same-guid');
    await setChatCustomization(t.db, 'iMessage;-;same-guid', {
      customName: 'B local name',
      customColor: '#00bb00',
    });

    let current = true;
    t.raw.function('revoke_backup_ownership', () => {
      current = false;
      return 0;
    });
    t.raw.exec(`
      CREATE TRIGGER revoke_backup_during_chat_update
      AFTER UPDATE OF custom_name ON chats
      BEGIN
        SELECT revoke_backup_ownership();
      END
    `);

    await expect(
      restoreBackup(
        t.db,
        {
          version: 1,
          exportedAt: 1,
          kv: [{ key: 'theme.preset', value: 'nord' }],
          themes: [{ name: 'A imported theme', mode: 'dark', tokens: '{}', isPreset: 0 }],
          chatCustomizations: [
            {
              guid: 'iMessage;-;same-guid',
              customName: 'A restored name',
              customColor: '#aa0000',
              muteType: null,
              isPinned: 1,
              isArchived: 0,
            },
          ],
        },
        () => current,
      ),
    ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);

    expect(
      t.raw
        .prepare(
          `SELECT custom_name AS customName, custom_color AS customColor,
                  is_pinned AS isPinned
             FROM chats WHERE guid = ?`,
        )
        .get('iMessage;-;same-guid'),
    ).toEqual({ customName: 'B local name', customColor: '#00bb00', isPinned: 0 });
    expect(t.raw.prepare("SELECT value FROM kv WHERE key = 'theme.preset'").get()).toBeUndefined();
    expect(
      t.raw.prepare("SELECT id FROM themes WHERE name = 'A imported theme'").get(),
    ).toBeUndefined();
  });
});

describe('parseBackup', () => {
  const validBackup = (): Backup => ({
    version: 1,
    exportedAt: 1,
    kv: [],
    themes: [],
    chatCustomizations: [],
  });

  it('rejects malformed JSON and bad schema', () => {
    expect(() => parseBackup('not json')).toThrow();
    expect(() => parseBackup(JSON.stringify({ version: 2 }))).toThrow();
    expect(() =>
      parseBackup(JSON.stringify({ version: 1, exportedAt: 1, kv: [], themes: [] })),
    ).toThrow(); // missing chatCustomizations
  });

  it('rejects plaintext over the global cap before JSON.parse', () => {
    expect(() => parseBackup('x'.repeat(BACKUP_LIMITS.plaintextCharacters + 1))).toThrow(
      BackupInputLimitError,
    );
  });

  it('also applies the plaintext cap in UTF-8 bytes', () => {
    const multibyte = '界'.repeat(Math.floor(BACKUP_LIMITS.plaintextBytes / 3) + 1);
    expect(multibyte.length).toBeLessThan(BACKUP_LIMITS.plaintextCharacters);
    expect(() => parseBackup(multibyte)).toThrow('backup-input-limit:plaintext-too-large');
  });

  it.each([
    ['kv', BACKUP_LIMITS.kvEntries, { key: 'theme.preset', value: 'dark' }],
    ['themes', BACKUP_LIMITS.themes, { name: 'Theme', mode: 'dark', tokens: '{}', isPreset: 0 }],
    [
      'chatCustomizations',
      BACKUP_LIMITS.chatCustomizations,
      {
        guid: 'iMessage;-;chat',
        customName: null,
        customColor: null,
        muteType: null,
        isPinned: 0,
        isArchived: 0,
      },
    ],
  ] as const)('bounds the %s collection', (field, max, row) => {
    const backup = validBackup();
    // Deliberately bypass the inferred tuple type to build hostile runtime JSON.
    (backup as unknown as Record<string, unknown[]>)[field] = Array.from(
      { length: max + 1 },
      () => row,
    );
    expect(() => BackupSchema.parse(backup)).toThrow();
  });

  it('bounds individual strings even when the whole file is below the global cap', () => {
    const backup = validBackup();
    backup.themes.push({
      name: 'x'.repeat(BACKUP_LIMITS.themeNameCharacters + 1),
      mode: 'dark',
      tokens: '{}',
      isPreset: 0,
    });
    expect(() => BackupSchema.parse(backup)).toThrow();
  });
});

describe('encrypted backup (sealBackup/openBackup)', () => {
  // Argon2id is intentionally slow; use the lightest params for tests.
  const cheapArgon = { opsLimit: 1, memLimit: 8 * 1024 * 1024 };
  const makeBox = async (): Promise<SecretBox> =>
    new SecretBox(await createLibsodiumBackend(), cheapArgon);

  it('round-trips in bounded authenticated chunks and leaks no plaintext', async () => {
    const t = await createTestDb();
    await kvSet(t.db, 'theme.preset', 'oledDark');
    const backup = await buildBackup(t.db, { exportedAt: 7 });
    backup.themes.push({
      name: 'Large theme',
      mode: 'dark',
      tokens: 'x'.repeat(CHUNKED_SECRET_BOX_CHUNK_BYTES * 2 + 7),
      isPreset: 0,
    });
    const backend = await createLibsodiumBackend();
    const encrypt = jest.spyOn(backend, 'aeadEncrypt');
    const decrypt = jest.spyOn(backend, 'aeadDecrypt');
    const box = new SecretBox(backend, cheapArgon);
    const sealed = await sealBackup(box, backup, 'pass-123');
    expect(sealed.startsWith(CHUNKED_SECRET_BOX_PREFIX)).toBe(true);
    expect(sealed).not.toContain('oledDark');
    expect(looksEncrypted(sealed)).toBe(true);
    expect(encrypt).toHaveBeenCalledTimes(3);
    expect(
      encrypt.mock.calls.every(
        ([params]) => params.plaintext.length <= CHUNKED_SECRET_BOX_CHUNK_BYTES,
      ),
    ).toBe(true);
    expect(await openBackup(box, sealed, 'pass-123')).toEqual(backup);
    expect(decrypt).toHaveBeenCalledTimes(3);
    expect(
      decrypt.mock.calls.every(
        ([params]) => params.ciphertext.length <= CHUNKED_SECRET_BOX_CHUNK_BYTES + 16,
      ),
    ).toBe(true);
  });

  it('open rejects a wrong passphrase (authenticated)', async () => {
    const t = await createTestDb();
    const box = await makeBox();
    const sealed = await sealBackup(box, await buildBackup(t.db, { exportedAt: 1 }), 'right');
    await expect(openBackup(box, sealed, 'wrong')).rejects.toBeDefined();
  });

  it('open rejects a tampered envelope', async () => {
    const t = await createTestDb();
    const box = await makeBox();
    const sealed = await sealBackup(box, await buildBackup(t.db, { exportedAt: 1 }), 'pp');
    const frameStart = sealed.indexOf('.', CHUNKED_SECRET_BOX_PREFIX.length) + 1;
    const tampered = `${sealed.slice(0, frameStart)}${sealed.charAt(frameStart) === 'A' ? 'B' : 'A'}${sealed.slice(frameStart + 1)}`;
    await expect(openBackup(box, tampered, 'pp')).rejects.toBeDefined();
  });

  it('rejects an oversized BB2 plaintext claim before Argon2', async () => {
    const backend = await createLibsodiumBackend();
    const deriveKey = jest.spyOn(backend, 'deriveKey');
    const box = new SecretBox(backend, cheapArgon);
    const backup: Backup = {
      version: 1,
      exportedAt: 1,
      kv: [],
      themes: [],
      chatCustomizations: [],
    };
    const sealed = await sealBackup(box, backup, 'pp');
    deriveKey.mockClear();

    const headerEnd = sealed.indexOf('.', CHUNKED_SECRET_BOX_PREFIX.length);
    const header = fromBase64(sealed.slice(CHUNKED_SECRET_BOX_PREFIX.length, headerEnd));
    new DataView(header.buffer, header.byteOffset, header.byteLength).setUint32(
      header.length - 4,
      BACKUP_LIMITS.plaintextBytes + 1,
    );
    const forged = `${CHUNKED_SECRET_BOX_PREFIX}${toBase64(header)}${sealed.slice(headerEnd)}`;

    await expect(openBackup(box, forged, 'pp')).rejects.toThrow(
      'backup-input-limit:plaintext-too-large',
    );
    expect(deriveKey).not.toHaveBeenCalled();
  });

  it('rejects missing, appended, or mis-padded BB2 frames before Argon2', async () => {
    const backend = await createLibsodiumBackend();
    const deriveKey = jest.spyOn(backend, 'deriveKey');
    const box = new SecretBox(backend, cheapArgon);
    const backup: Backup = {
      version: 1,
      exportedAt: 1,
      kv: [],
      themes: [
        {
          name: 'Large theme',
          mode: 'dark',
          tokens: 'x'.repeat(CHUNKED_SECRET_BOX_CHUNK_BYTES + 1),
          isPreset: 0,
        },
      ],
      chatCustomizations: [],
    };
    const sealed = await sealBackup(box, backup, 'pp');
    deriveKey.mockClear();

    await expect(openBackup(box, sealed.slice(0, sealed.lastIndexOf('.')), 'pp')).rejects.toThrow(
      'truncated chunked envelope',
    );
    await expect(openBackup(box, `${sealed}.QUFBQQ==`, 'pp')).rejects.toThrow(
      'extra chunked envelope frame',
    );

    const finalSeparator = sealed.lastIndexOf('.');
    const finalToken = sealed.slice(finalSeparator + 1);
    const wrongPadding = finalToken.endsWith('==')
      ? `${finalToken.slice(0, -2)}AA`
      : finalToken.endsWith('=')
        ? `${finalToken.slice(0, -1)}A`
        : `${finalToken.slice(0, -3)}A==`;
    await expect(
      openBackup(box, `${sealed.slice(0, finalSeparator + 1)}${wrongPadding}`, 'pp'),
    ).rejects.toThrow('malformed chunked envelope frame');
    expect(deriveKey).not.toHaveBeenCalled();
  });

  it('bounds legacy v1 bodies before Argon2 and rejects malformed UTF-8 before JSON', async () => {
    const salt = new Uint8Array(CRYPTO_SIZES.salt);
    const nonce = new Uint8Array(CRYPTO_SIZES.nonce);
    const backend = await createLibsodiumBackend();
    const deriveKey = jest.spyOn(backend, 'deriveKey');
    const box = new SecretBox(backend, cheapArgon);

    await expect(
      openBackup(
        box,
        encodeEnvelope({
          salt,
          nonce,
          body: new Uint8Array(SECRET_BOX_AEAD_TAG_BYTES - 1),
        }),
        'pp',
      ),
    ).rejects.toThrow('envelope body too short');
    await expect(
      openBackup(
        box,
        encodeEnvelope({
          salt,
          nonce,
          body: new Uint8Array(BACKUP_LIMITS.plaintextBytes + SECRET_BOX_AEAD_TAG_BYTES + 1),
        }),
        'pp',
      ),
    ).rejects.toThrow('backup-input-limit:plaintext-too-large');
    expect(deriveKey).not.toHaveBeenCalled();

    const invalidUtf8Backend = {
      deriveKey: jest.fn(async () => new Uint8Array(CRYPTO_SIZES.key)),
      aeadDecrypt: jest.fn(async () => Uint8Array.of(0xff)),
    } as unknown as CryptoBackend;
    const invalidUtf8Box = new SecretBox(invalidUtf8Backend, cheapArgon);
    await expect(
      openBackup(
        invalidUtf8Box,
        encodeEnvelope({
          salt,
          nonce,
          body: new Uint8Array(SECRET_BOX_AEAD_TAG_BYTES),
        }),
        'pp',
      ),
    ).rejects.toThrow('secret box plaintext is not valid UTF-8');
  });

  it('rejects an oversized encoded envelope before calling the base64 decoder', async () => {
    const openBounded = jest.fn();
    const box = { openBounded } as unknown as SecretBox;
    await expect(
      openBackup(box, 'A'.repeat(BACKUP_LIMITS.encodedCharacters + 1), 'old-passphrase'),
    ).rejects.toThrow('backup-input-limit:encoded-too-large');
    expect(openBounded).not.toHaveBeenCalled();
  });

  it('rejects oversized decrypted plaintext before JSON.parse', async () => {
    const openBounded = jest.fn(async () => 'x'.repeat(BACKUP_LIMITS.plaintextCharacters + 1));
    const box = { openBounded } as unknown as SecretBox;
    await expect(openBackup(box, 'small-envelope', 'old-passphrase')).rejects.toThrow(
      'backup-input-limit:plaintext-too-large',
    );
    expect(openBounded).toHaveBeenCalledTimes(1);
  });

  it('the no-secrets guard survives encrypt → decrypt → restore (import-side filter)', async () => {
    const src = await createTestDb();
    await kvSet(src.db, 'theme.preset', 'nord');
    const backup = await buildBackup(src.db, { exportedAt: 1 });
    // Forge an old/hostile backup with kv entries that buildBackup would have stripped.
    backup.kv.push({ key: 'server.password', value: 'hunter2' });
    backup.kv.push({ key: 'privacy.redactedMode', value: '1' });
    const box = await makeBox();
    const opened = await openBackup(box, await sealBackup(box, backup, 'pp'), 'pp');

    const dst = await createTestDb();
    await restoreBackup(dst.db, opened);
    expect(
      dst.raw.prepare("SELECT value FROM kv WHERE key='server.password'").get(),
    ).toBeUndefined();
    expect(
      dst.raw.prepare("SELECT value FROM kv WHERE key='privacy.redactedMode'").get(),
    ).toBeUndefined();
    const ok = dst.raw.prepare("SELECT value FROM kv WHERE key='theme.preset'").get() as
      { value: string } | undefined;
    expect(ok?.value).toBe('nord');
  });
});

describe('new backup passphrase policy', () => {
  it('requires 12 characters for new exports', () => {
    expect(MIN_NEW_BACKUP_PASSPHRASE_LENGTH).toBe(12);
    expect(getNewBackupPassphraseIssue('elevenchars')).toBe('too-short');
    expect(getNewBackupPassphraseIssue('🔐'.repeat(6))).toBe('too-short');
    expect(getNewBackupPassphraseIssue('twelve-chars')).toBeNull();
  });

  it('rejects common phrases case-insensitively, but accepts a distinct long phrase', () => {
    expect(getNewBackupPassphraseIssue('  PASSWORD1234  ')).toBe('too-common');
    expect(getNewBackupPassphraseIssue('            ')).toBe('too-short');
    expect(getNewBackupPassphraseIssue('river-lantern-orbit-92')).toBeNull();
  });
});

describe('looksEncrypted', () => {
  it('distinguishes plaintext JSON from an encrypted envelope', () => {
    expect(looksEncrypted('{"version":1}')).toBe(false);
    expect(looksEncrypted('  \n{"version":1}')).toBe(false);
    expect(looksEncrypted('Qk0BabcdEF==')).toBe(true);
  });
});
