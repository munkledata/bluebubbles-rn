/**
 * backupService (src/services/backup/backupService.ts) — the export/import orchestration
 * over expo-file-system + expo-sharing. Pins the AGENTS.md security contract:
 *   1. the plaintext/encrypted export file written to the cache dir is DELETED in a
 *      finally after the share sheet — even when sharing throws — so it never lingers;
 *   2. sharing-unavailable also deletes the file before throwing;
 *   3. the written plaintext export contains NO secret-looking kv values (buildBackup's
 *      filter, asserted end-to-end here on the actual written bytes);
 *   4. the encrypted export writes the sealed envelope (never the plaintext), and the
 *      full seal→share→import round-trip restores settings under the right passphrase.
 *
 * expo-file-system / expo-sharing / expo-constants are mocked in-file; the DB is a real
 * in-memory better-sqlite3 via the mocked getDatabase; crypto is the REAL SecretBox over
 * the Node libsodium backend (cheap Argon2id params for speed).
 */
import { SecretBox } from '@core/crypto';
import { kvGet, kvSet } from '@db/repositories';
import { getDatabase } from '@db/database';
import { createLibsodiumBackend } from '../support/libsodiumBackend';
import { createTestDb } from '../support/testDb';

// ---- in-file mocks ---------------------------------------------------------

/** One fake cache file per (dir, name); records writes + lifecycle for assertions. */
class MockFile {
  static instances: MockFile[] = [];
  exists = false;
  content: string | null = null;
  deletes = 0;
  readonly uri: string;
  constructor(_dir: string, name: string) {
    this.uri = `file:///cache/${name}`;
    MockFile.instances.push(this);
  }
  create(): void {
    this.exists = true;
  }
  write(text: string): void {
    this.content = text;
  }
  delete(): void {
    this.exists = false;
    this.deletes += 1;
  }
}

jest.mock('expo-file-system', () => ({
  File: MockFile,
  Paths: { cache: '/cache' },
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));
jest.mock('expo-constants', () => ({ expoConfig: { version: '1.2.3' } }));
jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));

const cheapArgon = { opsLimit: 1, memLimit: 8 * 1024 * 1024 };
const mockGetSecretBox = jest.fn(
  async () => new SecretBox(await createLibsodiumBackend(), cheapArgon),
);
jest.mock('@/services/clients', () => ({ getSecretBox: () => mockGetSecretBox() }));

// eslint-disable-next-line import/first
import * as Sharing from 'expo-sharing';
// eslint-disable-next-line import/first
import {
  exportBackup,
  exportEncryptedBackup,
  importBackupAuto,
} from '@/services/backup/backupService';

const mockShare = Sharing.shareAsync as jest.Mock;
const mockAvailable = Sharing.isAvailableAsync as jest.Mock;
const mockGetDatabase = getDatabase as jest.Mock;

async function seedDb() {
  const t = await createTestDb();
  mockGetDatabase.mockReturnValue(t.db);
  await kvSet(t.db, 'theme.preset', 'nord');
  await kvSet(t.db, 'server.password', 'hunter2'); // must NEVER leave the device
  return t.db;
}

beforeEach(() => {
  MockFile.instances = [];
  mockAvailable.mockResolvedValue(true);
  mockShare.mockResolvedValue(undefined);
});

const theFile = (): MockFile => {
  expect(MockFile.instances).toHaveLength(1);
  return MockFile.instances[0]!;
};

// ---- plaintext export ------------------------------------------------------

describe('exportBackup', () => {
  it('writes the backup, shares it, and deletes the cache file afterwards', async () => {
    await seedDb();
    await exportBackup(1_000);

    const f = theFile();
    expect(mockShare).toHaveBeenCalledWith(
      f.uri,
      expect.objectContaining({ mimeType: 'application/json' }),
    );
    expect(f.exists).toBe(false); // the finally-delete ran
    expect(f.deletes).toBeGreaterThanOrEqual(1);
    // The written export carries settings but NO secret kv values (filter pin).
    expect(f.content).toContain('nord');
    expect(f.content).not.toContain('hunter2');
    expect(f.content).not.toContain('server.password');
  });

  it('deletes the cache file even when the share sheet throws (the security pin)', async () => {
    await seedDb();
    mockShare.mockRejectedValueOnce(new Error('share cancelled by OS'));
    await expect(exportBackup(1_000)).rejects.toThrow('share cancelled by OS');
    expect(theFile().exists).toBe(false);
  });

  it('deletes the cache file and throws when sharing is unavailable', async () => {
    await seedDb();
    mockAvailable.mockResolvedValueOnce(false);
    await expect(exportBackup(1_000)).rejects.toThrow('sharing-unavailable');
    expect(theFile().exists).toBe(false);
    expect(mockShare).not.toHaveBeenCalled();
  });
});

// ---- encrypted export + import round-trip ----------------------------------

describe('exportEncryptedBackup / importBackupAuto', () => {
  it('writes the SEALED envelope (never plaintext) and deletes it after sharing', async () => {
    await seedDb();
    await exportEncryptedBackup('correct horse battery staple', 2_000);

    const f = theFile();
    expect(f.uri).toContain('.gatorbackup');
    expect(f.exists).toBe(false);
    // Sealed blob: not the JSON backup, and leaks neither settings nor secrets.
    expect(f.content).not.toContain('nord');
    expect(f.content).not.toContain('hunter2');
    expect(f.content).not.toContain('"kv"');
  });

  it('deletes the encrypted cache file even when sharing throws', async () => {
    await seedDb();
    mockShare.mockRejectedValueOnce(new Error('boom'));
    await expect(exportEncryptedBackup('pw', 2_000)).rejects.toThrow('boom');
    expect(theFile().exists).toBe(false);
  });

  it('round-trips: the sealed export restores settings into a fresh DB under the right passphrase', async () => {
    await seedDb();
    await exportEncryptedBackup('correct horse battery staple', 2_000);
    const sealed = theFile().content!;

    // Fresh device: new DB, then import the sealed text (auto-detects encrypted).
    const fresh = await createTestDb();
    mockGetDatabase.mockReturnValue(fresh.db);
    const res = await importBackupAuto(sealed, 'correct horse battery staple');
    expect(res.kv).toBeGreaterThanOrEqual(1);
    expect(await kvGet(fresh.db, 'theme.preset')).toBe('nord');
    // The secret never round-trips — it was filtered out at build time.
    expect(await kvGet(fresh.db, 'server.password')).toBeNull();
  });

  it('rejects a wrong passphrase (tamper/auth failure surfaces, nothing restored)', async () => {
    await seedDb();
    await exportEncryptedBackup('right-passphrase', 2_000);
    const sealed = theFile().content!;

    const fresh = await createTestDb();
    mockGetDatabase.mockReturnValue(fresh.db);
    await expect(importBackupAuto(sealed, 'wrong-passphrase')).rejects.toThrow();
    expect(await kvGet(fresh.db, 'theme.preset')).toBeNull();
  });

  it('auto-detect routes legacy plaintext JSON without needing the passphrase', async () => {
    await seedDb();
    await exportBackup(1_000);
    const json = theFile().content!;

    const fresh = await createTestDb();
    mockGetDatabase.mockReturnValue(fresh.db);
    const res = await importBackupAuto(json, '');
    expect(res.kv).toBeGreaterThanOrEqual(1);
    expect(await kvGet(fresh.db, 'theme.preset')).toBe('nord');
  });
});
