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
import type { AppDatabase } from '@db/types';
import { createLibsodiumBackend } from '../support/libsodiumBackend';
import { createTestDb } from '../support/testDb';
import { BACKUP_LIMITS } from '@/services/backup/backupSchema';

// ---- in-file mocks ---------------------------------------------------------

/** One fake cache file per (dir, name); records writes + lifecycle for assertions. */
class MockFile {
  static instances: MockFile[] = [];
  static textImpl: ((file: MockFile) => Promise<string>) | null = null;
  static deleteError: Error | null = null;
  static nextSize: number | null = 1_024;
  static textCalls = 0;
  exists = false;
  content: string | null = null;
  deletes = 0;
  readonly size: number | null;
  readonly uri: string;
  constructor(dirOrUri: string, name?: string) {
    this.uri = name === undefined ? dirOrUri : `file:///cache/${name}`;
    this.size = MockFile.nextSize;
    if (name === undefined) this.exists = true;
    MockFile.instances.push(this);
  }
  create(): void {
    this.exists = true;
  }
  write(text: string): void {
    this.content = text;
  }
  async text(): Promise<string> {
    MockFile.textCalls += 1;
    if (MockFile.textImpl) return MockFile.textImpl(this);
    return this.content ?? '';
  }
  delete(): void {
    if (MockFile.deleteError) throw MockFile.deleteError;
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
  BackupAccountChangedError,
  BackupPassphraseRejectedError,
  exportBackup,
  exportEncryptedBackup,
  importBackupAuto,
  readPickedBackupCopy,
} from '@/services/backup/backupService';
// eslint-disable-next-line import/first
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const mockShare = Sharing.shareAsync as jest.Mock;
const mockAvailable = Sharing.isAvailableAsync as jest.Mock;
const mockGetDatabase = getDatabase as jest.Mock;

/** A composer draft: the key embeds the counterparty's number, the value is unsent text. */
const DRAFT_KEY = 'draft.iMessage;-;+15555550123';
const DRAFT_TEXT = 'half-typed and never sent';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('deferred backup operation did not reach its test seam');
}

async function seedDb() {
  const t = await createTestDb();
  mockGetDatabase.mockReturnValue(t.db);
  await kvSet(t.db, 'theme.preset', 'nord');
  await kvSet(t.db, 'server.password', 'hunter2'); // must NEVER leave the device
  // Neither of these is a setting, and neither may leave the device either: message content +
  // the handle it was addressed to, and this install's deleted-message catch-up watermark.
  await kvSet(t.db, DRAFT_KEY, DRAFT_TEXT);
  await kvSet(t.db, 'sync.deletionsSyncedAt', '1900000000000');
  return t.db;
}

beforeEach(() => {
  MockFile.instances = [];
  MockFile.textImpl = null;
  MockFile.deleteError = null;
  MockFile.nextSize = 1_024;
  MockFile.textCalls = 0;
  mockAvailable.mockReset().mockResolvedValue(true);
  mockShare.mockReset().mockResolvedValue(undefined);
  mockGetDatabase.mockReset();
  mockGetSecretBox
    .mockReset()
    .mockImplementation(async () => new SecretBox(await createLibsodiumBackend(), cheapArgon));
  resumeRealtimeDeliveries();
});

afterEach(() => {
  resumeRealtimeDeliveries();
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
    // …nor unsent message text, the address it was aimed at, or device-local sync state.
    expect(f.content).not.toContain(DRAFT_TEXT);
    expect(f.content).not.toContain('+15555550123');
    expect(f.content).not.toContain('sync.deletionsSyncedAt');
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
    // Availability is checked before writing, so there is no generated file to clean up.
    expect(MockFile.instances).toHaveLength(0);
    expect(mockShare).not.toHaveBeenCalled();
  });

  it('does not let a delayed A build open an export after Disconnect', async () => {
    const realDb = await seedDb();
    const readStarted = deferred<void>();
    const releaseReads = deferred<void>();
    const runAll = realDb.all.bind(realDb) as unknown as (query: unknown) => Promise<unknown[]>;
    const delayedDb = {
      all: jest.fn(async (query: unknown) => {
        readStarted.resolve();
        await releaseReads.promise;
        return runAll(query);
      }),
    } as unknown as AppDatabase;
    mockGetDatabase.mockReturnValue(delayedDb);
    const oldScreenLease = captureRealtimeDeliveryLease();

    const pending = exportEncryptedBackup('old account passphrase', 3_000, oldScreenLease);
    await readStarted.promise;

    let drained = false;
    const drain = pauseRealtimeDeliveries().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false); // the short account DB read is visible to teardown

    releaseReads.resolve();
    await drain;
    resumeRealtimeDeliveries();

    await expect(pending).rejects.toBeInstanceOf(BackupAccountChangedError);
    expect(mockGetSecretBox).not.toHaveBeenCalled();
    expect(mockShare).not.toHaveBeenCalled();
    expect(MockFile.instances).toHaveLength(0);
  });

  it('deletes a late picker cache copy without holding the Disconnect drain', async () => {
    const readFinished = deferred<string>();
    MockFile.textImpl = () => readFinished.promise;
    const oldScreenLease = captureRealtimeDeliveryLease();

    const pending = readPickedBackupCopy('file:///cache/picked.gatorbackup', oldScreenLease);
    await waitUntil(() => MockFile.instances.length === 1);

    // Reading a user-selected file is not a DB/native account mutation, so teardown stays free.
    await expect(pauseRealtimeDeliveries()).resolves.toBeUndefined();
    resumeRealtimeDeliveries();
    readFinished.resolve('  encrypted old-account backup  ');

    await expect(pending).rejects.toBeInstanceOf(BackupAccountChangedError);
    expect(theFile().exists).toBe(false);
    expect(theFile().deletes).toBe(1);
  });

  it('keeps account-change cancellation authoritative when picker-cache deletion fails', async () => {
    const readFinished = deferred<string>();
    MockFile.textImpl = () => readFinished.promise;
    const oldScreenLease = captureRealtimeDeliveryLease();

    const pending = readPickedBackupCopy('file:///cache/picked.gatorbackup', oldScreenLease);
    await waitUntil(() => MockFile.instances.length === 1);
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    MockFile.deleteError = new Error('cache entry was already reclaimed');
    readFinished.resolve('encrypted old-account backup');

    await expect(pending).rejects.toBeInstanceOf(BackupAccountChangedError);
  });

  it('normalizes a picker read failure that arrives after account retirement', async () => {
    let rejectRead!: (error: unknown) => void;
    MockFile.textImpl = () =>
      new Promise<string>((_resolve, reject) => {
        rejectRead = reject;
      });
    const oldScreenLease = captureRealtimeDeliveryLease();

    const pending = readPickedBackupCopy('file:///cache/picked.gatorbackup', oldScreenLease);
    const outcome = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await waitUntil(() => MockFile.textCalls === 1);
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    rejectRead(new Error('old picker read failed'));

    await expect(outcome).resolves.toBeInstanceOf(BackupAccountChangedError);
    expect(theFile().exists).toBe(false);
    expect(theFile().deletes).toBe(1);
  });

  it('rejects an oversized picked file before reading it and deletes the private copy', async () => {
    MockFile.nextSize = BACKUP_LIMITS.fileBytes + 1;

    await expect(readPickedBackupCopy('file:///cache/hostile.gatorbackup')).rejects.toThrow(
      'backup-input-limit:file-too-large',
    );
    expect(MockFile.textCalls).toBe(0);
    expect(theFile().exists).toBe(false);
    expect(theFile().deletes).toBe(1);
  });
});

// ---- encrypted export + import round-trip ----------------------------------

describe('exportEncryptedBackup / importBackupAuto', () => {
  it.each([
    ['short', 'only-short'],
    ['common', 'password1234'],
    ['app-specific', 'bluebubbles1234'],
  ])('rejects a %s passphrase before reading account data', async (_case, passphrase) => {
    await expect(exportEncryptedBackup(passphrase, 2_000)).rejects.toBeInstanceOf(
      BackupPassphraseRejectedError,
    );
    expect(mockGetDatabase).not.toHaveBeenCalled();
    expect(mockGetSecretBox).not.toHaveBeenCalled();
    expect(mockShare).not.toHaveBeenCalled();
  });

  it('keeps account retirement authoritative over a weak-passphrase error', async () => {
    const retiredLease = captureRealtimeDeliveryLease();
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();

    await expect(exportEncryptedBackup('short', 2_000, retiredLease)).rejects.toBeInstanceOf(
      BackupAccountChangedError,
    );
    expect(mockGetDatabase).not.toHaveBeenCalled();
  });

  it('writes the SEALED envelope (never plaintext) and deletes it after sharing', async () => {
    await seedDb();
    await exportEncryptedBackup('river-lantern-orbit-92', 2_000);

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
    await expect(exportEncryptedBackup('river-lantern-orbit-92', 2_000)).rejects.toThrow('boom');
    expect(theFile().exists).toBe(false);
  });

  it('normalizes a native-share failure that arrives after account retirement', async () => {
    await seedDb();
    mockGetSecretBox.mockResolvedValueOnce({
      sealChunked: jest.fn(async () => 'sealed-backup'),
    } as unknown as SecretBox);
    const sheet = deferred<void>();
    mockShare.mockReturnValueOnce(sheet.promise);
    const oldScreenLease = captureRealtimeDeliveryLease();
    const pending = exportEncryptedBackup('river-lantern-orbit-92', 2_001, oldScreenLease);
    const outcome = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await waitUntil(() => mockShare.mock.calls.length === 1);

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    sheet.reject(new Error('old native share failed'));

    await expect(outcome).resolves.toBeInstanceOf(BackupAccountChangedError);
    expect(theFile().exists).toBe(false);
  });

  it('normalizes a crypto-loader failure that arrives after account retirement', async () => {
    await seedDb();
    const box = deferred<SecretBox>();
    mockGetSecretBox.mockReturnValueOnce(box.promise);
    const oldScreenLease = captureRealtimeDeliveryLease();
    const pending = exportEncryptedBackup('river-lantern-orbit-92', 2_002, oldScreenLease);
    const outcome = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await waitUntil(() => mockGetSecretBox.mock.calls.length === 1);

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    box.reject(new Error('old crypto loader failed'));

    await expect(outcome).resolves.toBeInstanceOf(BackupAccountChangedError);
    expect(MockFile.instances).toHaveLength(0);
  });

  it('does not hold Disconnect behind an already-open OS share sheet', async () => {
    await seedDb();
    const sheetClosed = deferred<void>();
    mockShare.mockReturnValueOnce(sheetClosed.promise);
    const oldScreenLease = captureRealtimeDeliveryLease();

    let settled = false;
    const pending = exportEncryptedBackup('river-lantern-orbit-92', 2_001, oldScreenLease).finally(
      () => {
        settled = true;
      },
    );
    await waitUntil(() => mockShare.mock.calls.length === 1);

    await expect(pauseRealtimeDeliveries()).resolves.toBeUndefined();
    expect(settled).toBe(false); // the OS sheet is still open, but teardown is free to continue
    resumeRealtimeDeliveries();

    sheetClosed.resolve();
    await expect(pending).rejects.toBeInstanceOf(BackupAccountChangedError);
    expect(theFile().exists).toBe(false);
  });

  it('round-trips: the sealed export restores settings into a fresh DB under the right passphrase', async () => {
    await seedDb();
    await exportEncryptedBackup('river-lantern-orbit-92', 2_000);
    const sealed = theFile().content!;

    // Fresh device: new DB, then import the sealed text (auto-detects encrypted).
    const fresh = await createTestDb();
    mockGetDatabase.mockReturnValue(fresh.db);
    const res = await importBackupAuto(sealed, 'river-lantern-orbit-92');
    expect(res.kv).toBeGreaterThanOrEqual(1);
    expect(await kvGet(fresh.db, 'theme.preset')).toBe('nord');
    // The secret never round-trips — it was filtered out at build time.
    expect(await kvGet(fresh.db, 'server.password')).toBeNull();
    // Nor does the draft, nor the source device's deletion watermark: restoring a newer
    // watermark would make this install skip the deletions it has not caught up on.
    expect(await kvGet(fresh.db, DRAFT_KEY)).toBeNull();
    expect(await kvGet(fresh.db, 'sync.deletionsSyncedAt')).toBeNull();
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

  it('continues to import an existing encrypted backup with a short passphrase', async () => {
    const box = new SecretBox(await createLibsodiumBackend(), cheapArgon);
    const sealed = await box.seal(
      JSON.stringify({
        version: 1,
        exportedAt: 1,
        kv: [{ key: 'theme.preset', value: 'nord' }],
        themes: [],
        chatCustomizations: [],
      }),
      'old',
    );
    mockGetSecretBox.mockResolvedValueOnce(box);
    const fresh = await createTestDb();
    mockGetDatabase.mockReturnValue(fresh.db);

    await expect(importBackupAuto(sealed, 'old')).resolves.toEqual({
      kv: 1,
      themes: 0,
      chatCustomizations: 0,
      chatCustomizationsSkipped: 0,
    });
    expect(await kvGet(fresh.db, 'theme.preset')).toBe('nord');
  });

  it("drops a decrypted A restore after reconnect instead of customizing B's same GUID", async () => {
    const opened = deferred<string>();
    const openBounded = jest.fn(() => opened.promise);
    mockGetSecretBox.mockResolvedValueOnce({ openBounded } as unknown as SecretBox);
    const oldScreenLease = captureRealtimeDeliveryLease();

    const pending = importBackupAuto('encrypted-old-account-envelope', 'pw', oldScreenLease);
    await waitUntil(() => openBounded.mock.calls.length === 1);

    // Decryption is pure CPU/crypto work and must not make Disconnect wait.
    await expect(pauseRealtimeDeliveries()).resolves.toBeUndefined();
    resumeRealtimeDeliveries();

    const next = await createTestDb();
    next.raw
      .prepare(`INSERT INTO chats (guid, custom_name) VALUES (?, ?)`)
      .run('iMessage;-;same-guid', 'B local name');
    mockGetDatabase.mockReturnValue(next.db);

    opened.resolve(
      JSON.stringify({
        version: 1,
        exportedAt: 4_000,
        kv: [],
        themes: [],
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
      }),
    );

    await expect(pending).rejects.toBeInstanceOf(BackupAccountChangedError);
    expect(mockGetDatabase).not.toHaveBeenCalled();
    expect(
      next.raw
        .prepare(`SELECT custom_name AS customName, custom_color AS customColor FROM chats`)
        .get(),
    ).toEqual({ customName: 'B local name', customColor: null });
    next.raw.close();
  });
});
