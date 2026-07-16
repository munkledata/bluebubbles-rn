/**
 * backfillServerAvatars: writes a server-sourced photo onto handles the device address book left
 * without one — matching by normalized phone/email, skipping already-downloaded files, and never
 * failing the caller on a per-handle download error. The filesystem (`expo-file-system`) and the
 * server contacts endpoint (`@core/api`'s `contactsApi`) are mocked in-file; the REAL encrypted
 * DB repo functions run against an in-memory SQLite (createTestDb).
 */
jest.mock('expo-file-system', () => {
  const FileCtor = jest.fn() as jest.Mock & { createDownloadTask: jest.Mock };
  FileCtor.createDownloadTask = jest.fn();
  const DirectoryCtor = jest.fn();
  return { Paths: { document: 'file:///doc' }, Directory: DirectoryCtor, File: FileCtor };
});

jest.mock('@core/api', () => ({
  contactsApi: {
    queryContactsByAddress: jest.fn(),
    contactAvatarUrl: jest.fn(() => 'https://server/api/v1/contact/c1/avatar?size=thumb'),
  },
}));

import { Directory, File } from 'expo-file-system';
import { contactsApi } from '@core/api';
import { backfillServerAvatars } from '@/services/contacts/serverAvatars';
import { upsertHandles } from '@db/repositories';
import { createTestDb } from '../support/testDb';

const MockFile = File as unknown as jest.Mock & { createDownloadTask: jest.Mock };
const MockDirectory = Directory as unknown as jest.Mock;
const mockQuery = contactsApi.queryContactsByAddress as jest.Mock;

const http = { buildHeaders: () => ({ Authorization: 'Bearer x' }) } as never;

/** Make `new File(dir, name)` yield a controllable {exists, uri}. */
function fileExists(exists: boolean) {
  MockFile.mockImplementation((_dir: unknown, name: string) => ({
    exists,
    uri: `file:///doc/${name}`,
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  MockDirectory.mockImplementation(() => ({ create: jest.fn() }));
  MockFile.createDownloadTask.mockReturnValue({ downloadAsync: jest.fn().mockResolvedValue({}) });
  fileExists(false);
});

async function seedNeedy() {
  const t = await createTestDb();
  await upsertHandles(t.db, [{ address: '+15551234567', displayName: '+15551234567' }]);
  return t;
}

const contactWithPhoto = {
  id: 'c1',
  hasAvatar: true,
  phoneNumbers: ['(555) 123-4567'], // matches +15551234567 by last-10-digits
  avatarEtag: 'e1',
};

describe('backfillServerAvatars', () => {
  it('returns 0 (and never queries the server) when no handle needs an avatar', async () => {
    const t = await createTestDb();
    expect(await backfillServerAvatars(t.db, http)).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 0 when the server has no matching contacts', async () => {
    const t = await seedNeedy();
    mockQuery.mockResolvedValue([]);
    expect(await backfillServerAvatars(t.db, http)).toBe(0);
  });

  it('returns 0 when matched contacts carry no usable avatar (no hasAvatar/id)', async () => {
    const t = await seedNeedy();
    mockQuery.mockResolvedValue([{ id: 'c1', hasAvatar: false, phoneNumbers: ['(555) 123-4567'] }]);
    expect(await backfillServerAvatars(t.db, http)).toBe(0);
  });

  it('downloads and writes the avatar onto a matching handle', async () => {
    const t = await seedNeedy();
    mockQuery.mockResolvedValue([contactWithPhoto]);

    expect(await backfillServerAvatars(t.db, http)).toBe(1);
    expect(MockFile.createDownloadTask).toHaveBeenCalledTimes(1);
    const avatar = (
      t.raw.prepare("SELECT avatar a FROM handles WHERE address='+15551234567'").get() as {
        a: string;
      }
    ).a;
    expect(avatar).toBe('file:///doc/c1-e1.img');
  });

  it('matches by email and names the file "v0" when the contact has no etag', async () => {
    const t = await createTestDb();
    await upsertHandles(t.db, [{ address: 'craig@apple.com', displayName: 'craig@apple.com' }]);
    mockQuery.mockResolvedValue([
      { id: 'c9', hasAvatar: true, emails: ['Craig@Apple.com'] }, // no avatarEtag
    ]);

    expect(await backfillServerAvatars(t.db, http)).toBe(1);
    const avatar = (
      t.raw.prepare("SELECT avatar a FROM handles WHERE address='craig@apple.com'").get() as {
        a: string;
      }
    ).a;
    expect(avatar).toBe('file:///doc/c9-v0.img');
  });

  it('reuses an already-downloaded file (no re-download) but still links it', async () => {
    const t = await seedNeedy();
    mockQuery.mockResolvedValue([contactWithPhoto]);
    fileExists(true); // the (id, etag) file is already on disk

    expect(await backfillServerAvatars(t.db, http)).toBe(1);
    expect(MockFile.createDownloadTask).not.toHaveBeenCalled();
  });

  it('skips a handle when the download yields no file', async () => {
    const t = await seedNeedy();
    mockQuery.mockResolvedValue([contactWithPhoto]);
    MockFile.createDownloadTask.mockReturnValue({
      downloadAsync: jest.fn().mockResolvedValue(null),
    });
    expect(await backfillServerAvatars(t.db, http)).toBe(0);
    const avatar = (
      t.raw.prepare("SELECT avatar a FROM handles WHERE address='+15551234567'").get() as {
        a: string | null;
      }
    ).a;
    expect(avatar).toBeNull();
  });

  it('swallows a per-handle download error (best-effort) and writes nothing', async () => {
    const t = await seedNeedy();
    mockQuery.mockResolvedValue([contactWithPhoto]);
    MockFile.createDownloadTask.mockReturnValue({
      downloadAsync: jest.fn().mockRejectedValue(new Error('network')),
    });
    expect(await backfillServerAvatars(t.db, http)).toBe(0);
  });
});
