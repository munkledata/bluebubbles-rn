import { Chat } from '@core/models';
import { kvSet, setChatCustomization, upsertChats, upsertHandles } from '@db/repositories';
import { SecretBox } from '@core/crypto';
import { fromBase64 } from '@utils/bytes';
import {
  buildBackup,
  openBackup,
  parseBackup,
  restoreBackup,
  sealBackup,
} from '@/services/backup/backup';
import { isSecretKey, looksEncrypted } from '@/services/backup/backupSchema';
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
});

describe('parseBackup', () => {
  it('rejects malformed JSON and bad schema', () => {
    expect(() => parseBackup('not json')).toThrow();
    expect(() => parseBackup(JSON.stringify({ version: 2 }))).toThrow();
    expect(() =>
      parseBackup(JSON.stringify({ version: 1, exportedAt: 1, kv: [], themes: [] })),
    ).toThrow(); // missing chatCustomizations
  });
});

describe('encrypted backup (sealBackup/openBackup)', () => {
  // Argon2id is intentionally slow; use the lightest params for tests.
  const cheapArgon = { opsLimit: 1, memLimit: 8 * 1024 * 1024 };
  const makeBox = async (): Promise<SecretBox> =>
    new SecretBox(await createLibsodiumBackend(), cheapArgon);

  it('round-trips and the ciphertext leaks no plaintext', async () => {
    const t = await createTestDb();
    await kvSet(t.db, 'theme.preset', 'oledDark');
    const backup = await buildBackup(t.db, { exportedAt: 7 });
    const box = await makeBox();
    const sealed = await sealBackup(box, backup, 'pass-123');
    expect(sealed).not.toContain('oledDark');
    expect(looksEncrypted(sealed)).toBe(true);
    expect(await openBackup(box, sealed, 'pass-123')).toEqual(backup);
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
    const raw = fromBase64(sealed);
    raw[raw.length - 1] = (raw[raw.length - 1]! ^ 0xff) & 0xff;
    const tampered = Buffer.from(raw).toString('base64');
    await expect(openBackup(box, tampered, 'pp')).rejects.toBeDefined();
  });

  it('the no-secrets guard survives encrypt → decrypt → restore (import-side filter)', async () => {
    const src = await createTestDb();
    await kvSet(src.db, 'theme.preset', 'nord');
    const backup = await buildBackup(src.db, { exportedAt: 1 });
    // Forge a malicious backup with a secret kv that buildBackup would have stripped.
    backup.kv.push({ key: 'server.password', value: 'hunter2' });
    const box = await makeBox();
    const opened = await openBackup(box, await sealBackup(box, backup, 'pp'), 'pp');

    const dst = await createTestDb();
    await restoreBackup(dst.db, opened);
    expect(
      dst.raw.prepare("SELECT value FROM kv WHERE key='server.password'").get(),
    ).toBeUndefined();
    const ok = dst.raw.prepare("SELECT value FROM kv WHERE key='theme.preset'").get() as
      | { value: string }
      | undefined;
    expect(ok?.value).toBe('nord');
  });
});

describe('looksEncrypted', () => {
  it('distinguishes plaintext JSON from an encrypted envelope', () => {
    expect(looksEncrypted('{"version":1}')).toBe(false);
    expect(looksEncrypted('  \n{"version":1}')).toBe(false);
    expect(looksEncrypted('Qk0BabcdEF==')).toBe(true);
  });
});
