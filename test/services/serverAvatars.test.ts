/**
 * backfillServerAvatars: writes a server-sourced photo onto handles the device address book left
 * without one — matching by normalized phone/email, skipping already-downloaded files, and never
 * failing the caller on a per-handle download error. The filesystem (`expo-file-system`) and the
 * server contacts endpoint (`@core/api`'s `contactsApi`) are mocked in-file; the REAL encrypted
 * DB repo functions run against an in-memory SQLite (createTestDb).
 */
jest.mock('expo-file-system', () => {
  const disk = new Map<string, number>();
  const deletes: string[] = [];
  const FileCtor = jest.fn(function (
    this: Record<string, unknown>,
    dir: { uri: string } | string,
    name?: string,
  ) {
    const base = typeof dir === 'string' ? dir : dir.uri;
    this.uri = name == null ? base : `${base}/${name}`;
    if (FileCtor.mockExistingBytes != null && !String(this.uri).endsWith('.part')) {
      disk.set(this.uri as string, FileCtor.mockExistingBytes);
    }
    Object.defineProperty(this, 'exists', {
      configurable: true,
      get: () => disk.has(this.uri as string),
    });
    Object.defineProperty(this, 'size', {
      configurable: true,
      get: () => disk.get(this.uri as string) ?? 0,
    });
    this.delete = jest.fn(() => {
      deletes.push(this.uri as string);
      disk.delete(this.uri as string);
    });
    this.move = jest.fn(async (destination: { uri: string }) => {
      const bytes = disk.get(this.uri as string);
      disk.delete(this.uri as string);
      if (bytes != null) disk.set(destination.uri, bytes);
      this.uri = destination.uri;
    });
  }) as jest.Mock & {
    createDownloadTask: jest.Mock;
    mockDeletes: string[];
    mockDisk: Map<string, number>;
    mockExistingBytes: number | null;
  };
  FileCtor.mockDeletes = deletes;
  FileCtor.mockDisk = disk;
  FileCtor.mockExistingBytes = null;
  FileCtor.createDownloadTask = jest.fn(
    (
      _url: string,
      destination: { uri: string },
      options?: { onProgress?: (progress: { bytesWritten: number; totalBytes: number }) => void },
    ) => ({
      cancel: jest.fn(),
      release: jest.fn(),
      downloadAsync: jest.fn(async () => {
        disk.set(destination.uri, 10);
        options?.onProgress?.({ bytesWritten: 10, totalBytes: 10 });
        return destination;
      }),
    }),
  );
  const DirectoryCtor = jest.fn();
  return {
    Paths: { cache: 'file:///cache', document: 'file:///doc' },
    Directory: DirectoryCtor,
    File: FileCtor,
  };
});

jest.mock('@core/api', () => ({
  contactsApi: {
    CONTACT_QUERY_MAX_ADDRESSES: 64,
    queryContactsByAddress: jest.fn(),
    contactAvatarUrl: jest.fn(() => 'https://server/api/v1/contact/c1/avatar?size=thumb'),
  },
}));

// eslint-disable-next-line import/first
import { Directory, File } from 'expo-file-system';
// eslint-disable-next-line import/first
import { contactsApi } from '@core/api';
// eslint-disable-next-line import/first
import {
  backfillServerAvatars,
  SERVER_AVATAR_MAX_FILES_PER_RUN,
  SERVER_AVATAR_MAX_BYTES,
  SERVER_AVATAR_MAX_TOTAL_DOWNLOAD_BYTES,
  SERVER_AVATAR_TIMEOUT_MS,
} from '@/services/contacts/serverAvatars';
// eslint-disable-next-line import/first
import { upsertHandles } from '@db/repositories';
// eslint-disable-next-line import/first
import { createTestDb } from '../support/testDb';
// eslint-disable-next-line import/first
import { logger } from '@core/secure';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const MockFile = File as unknown as jest.Mock & {
  createDownloadTask: jest.Mock;
  mockDeletes: string[];
  mockDisk: Map<string, number>;
  mockExistingBytes: number | null;
};
const MockDirectory = Directory as unknown as jest.Mock;
const mockQuery = contactsApi.queryContactsByAddress as jest.Mock;

const http = {
  snapshotTransport: () => ({
    headers: { Authorization: 'Bearer x' },
    buildUrl: (path: string) => `https://server/api/v1${path}`,
  }),
} as never;

/** Make `new File(dir, name)` yield a controllable {exists, uri}. */
function fileExists(exists: boolean, bytes = 10) {
  MockFile.mockExistingBytes = exists ? bytes : null;
}

function avatarFileName(id: string, etag: string): string {
  return `media-${encodeURIComponent(JSON.stringify([id, etag]))}.img`;
}

beforeEach(() => {
  jest.clearAllMocks();
  MockFile.mockDisk.clear();
  MockFile.mockDeletes.length = 0;
  MockFile.mockExistingBytes = null;
  MockDirectory.mockImplementation((...parts: string[]) => ({
    create: jest.fn(),
    delete: jest.fn(),
    exists: false,
    uri: parts.join('/'),
  }));
  MockFile.createDownloadTask.mockImplementation(
    (
      _url: string,
      destination: { uri: string },
      options?: { onProgress?: (progress: { bytesWritten: number; totalBytes: number }) => void },
    ) => ({
      cancel: jest.fn(),
      release: jest.fn(),
      downloadAsync: jest.fn(async () => {
        MockFile.mockDisk.set(destination.uri, 10);
        options?.onProgress?.({ bytesWritten: 10, totalBytes: 10 });
        return destination;
      }),
    }),
  );
});

afterEach(async () => {
  await pauseRealtimeDeliveries();
  resumeRealtimeDeliveries();
  jest.restoreAllMocks();
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

  it('bounds the DB candidates sent by one automatic avatar backfill', async () => {
    const t = await createTestDb();
    const addresses = Array.from(
      { length: SERVER_AVATAR_MAX_FILES_PER_RUN + 7 },
      (_unused, index) => `+1555${String(index).padStart(7, '0')}`,
    );
    await upsertHandles(
      t.db,
      addresses.map((address) => ({ address, displayName: address })),
    );
    mockQuery.mockResolvedValue([]);

    expect(await backfillServerAvatars(t.db, http)).toBe(0);

    expect(mockQuery.mock.calls[0]?.[1]).toHaveLength(SERVER_AVATAR_MAX_FILES_PER_RUN);
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
    expect(MockFile.createDownloadTask).toHaveBeenCalledWith(
      'https://server/api/v1/contact/c1/avatar?size=thumb',
      expect.anything(),
      expect.objectContaining({
        headers: { Authorization: 'Bearer x' },
        onProgress: expect.any(Function),
        signal: expect.any(Object),
      }),
    );
    const avatar = (
      t.raw.prepare("SELECT avatar a FROM handles WHERE address='+15551234567'").get() as {
        a: string;
      }
    ).a;
    expect(avatar).toMatch(
      new RegExp(
        `^file:///doc/server-contact-avatars/generation-\\d+/${avatarFileName('c1', 'e1')}$`,
      ),
    );
  });

  it('preserves a device photo that arrives during download and does not count a server write', async () => {
    const t = await seedNeedy();
    mockQuery.mockResolvedValue([contactWithPhoto]);
    MockFile.createDownloadTask.mockImplementation(
      (
        _url: string,
        destination: { uri: string },
        options?: { onProgress?: (progress: { bytesWritten: number; totalBytes: number }) => void },
      ) => ({
        cancel: jest.fn(),
        release: jest.fn(),
        downloadAsync: jest.fn(async () => {
          MockFile.mockDisk.set(destination.uri, 10);
          options?.onProgress?.({ bytesWritten: 10, totalBytes: 10 });
          t.raw
            .prepare("UPDATE handles SET avatar = 'content://device-photo' WHERE address = ?")
            .run('+15551234567');
          return destination;
        }),
      }),
    );

    await expect(backfillServerAvatars(t.db, http)).resolves.toBe(0);
    expect(
      (
        t.raw.prepare("SELECT avatar FROM handles WHERE address = '+15551234567'").get() as {
          avatar: string;
        }
      ).avatar,
    ).toBe('content://device-photo');
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
    expect(avatar).toMatch(
      new RegExp(
        `^file:///doc/server-contact-avatars/generation-\\d+/${avatarFileName('c9', 'v0')}$`,
      ),
    );
  });

  it('reuses an already-downloaded file (no re-download) but still links it', async () => {
    const t = await seedNeedy();
    mockQuery.mockResolvedValue([contactWithPhoto]);
    fileExists(true); // the (id, etag) file is already on disk

    expect(await backfillServerAvatars(t.db, http)).toBe(1);
    expect(MockFile.createDownloadTask).not.toHaveBeenCalled();
  });

  it('rejects a zero-byte cache entry and replaces it with a verified download', async () => {
    const t = await seedNeedy();
    mockQuery.mockResolvedValue([contactWithPhoto]);
    fileExists(true, 0);

    expect(await backfillServerAvatars(t.db, http)).toBe(1);

    expect(MockFile.createDownloadTask).toHaveBeenCalledTimes(1);
    expect(MockFile.mockDeletes.some((uri) => uri.endsWith(`/${avatarFileName('c1', 'e1')}`))).toBe(
      true,
    );
  });

  it("does not reuse another account generation's avatar destination", async () => {
    const first = await seedNeedy();
    mockQuery.mockResolvedValue([contactWithPhoto]);
    expect(await backfillServerAvatars(first.db, http)).toBe(1);
    const firstNamespace = MockDirectory.mock.calls
      .filter((call) => call[1] === 'server-contact-avatars')
      .at(-1)?.[2] as string;

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();

    const second = await seedNeedy();
    expect(await backfillServerAvatars(second.db, http)).toBe(1);
    const secondNamespace = MockDirectory.mock.calls
      .filter((call) => call[1] === 'server-contact-avatars')
      .at(-1)?.[2] as string;

    expect(firstNamespace).toMatch(/^generation-\d+$/);
    expect(secondNamespace).toMatch(/^generation-\d+$/);
    expect(secondNamespace).not.toBe(firstNamespace);
    expect(MockFile.createDownloadTask).toHaveBeenCalledTimes(2);
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
    const error = new Error('network');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const t = await seedNeedy();
    mockQuery.mockResolvedValue([contactWithPhoto]);
    MockFile.createDownloadTask.mockReturnValue({
      downloadAsync: jest.fn().mockRejectedValue(error),
    });
    expect(await backfillServerAvatars(t.db, http)).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      '[contacts] server-avatar backfill failed for a handle',
      error,
    );
  });

  it('cancels an avatar whose actual streamed bytes cross the 5 MiB cap', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const cancel = jest.fn();
    const t = await seedNeedy();
    mockQuery.mockResolvedValue([contactWithPhoto]);
    MockFile.createDownloadTask.mockImplementationOnce(
      (
        _url: string,
        destination: { uri: string },
        options: {
          onProgress: (progress: { bytesWritten: number; totalBytes: number }) => void;
        },
      ) => ({
        cancel,
        release: jest.fn(),
        downloadAsync: async () => {
          MockFile.mockDisk.set(destination.uri, SERVER_AVATAR_MAX_BYTES + 1);
          options.onProgress({ bytesWritten: SERVER_AVATAR_MAX_BYTES + 1, totalBytes: 1 });
          throw new Error('native cancelled');
        },
      }),
    );

    expect(await backfillServerAvatars(t.db, http)).toBe(0);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(MockFile.mockDisk.size).toBe(0);
    expect(warn.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ reason: 'size' }));
  });

  it('stops one avatar backfill at its bounded aggregate download budget', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const t = await createTestDb();
    const addresses = Array.from(
      { length: 8 },
      (_unused, index) => `+1555000${String(index).padStart(4, '0')}`,
    );
    await upsertHandles(
      t.db,
      addresses.map((address) => ({ address, displayName: address })),
    );
    mockQuery.mockResolvedValue(
      addresses.map((address, index) => ({
        id: `contact-${index}`,
        hasAvatar: true,
        phoneNumbers: [address],
        avatarEtag: 'v1',
      })),
    );
    const nativeCancels: jest.Mock[] = [];
    MockFile.createDownloadTask.mockImplementation(
      (
        _url: string,
        destination: { uri: string },
        options: {
          onProgress: (progress: { bytesWritten: number; totalBytes: number }) => void;
        },
      ) => {
        const cancel = jest.fn();
        nativeCancels.push(cancel);
        return {
          cancel,
          release: jest.fn(),
          downloadAsync: async () => {
            MockFile.mockDisk.set(destination.uri, SERVER_AVATAR_MAX_BYTES);
            options.onProgress({
              bytesWritten: SERVER_AVATAR_MAX_BYTES,
              totalBytes: SERVER_AVATAR_MAX_BYTES,
            });
            return destination;
          },
        };
      },
    );

    const expectedWritten = Math.floor(
      SERVER_AVATAR_MAX_TOTAL_DOWNLOAD_BYTES / SERVER_AVATAR_MAX_BYTES,
    );
    expect(await backfillServerAvatars(t.db, http)).toBe(expectedWritten);

    expect(MockFile.createDownloadTask).toHaveBeenCalledTimes(expectedWritten + 1);
    // The seventh 5 MiB response is cancelled while streaming against the 2 MiB aggregate
    // remainder; it is not downloaded fully and rejected only after promotion.
    expect(nativeCancels.at(-1)).toHaveBeenCalledTimes(1);
    expect(MockFile.mockDisk.size).toBe(expectedWritten);
    expect(warn.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ reason: 'size' }));
  });

  it('cancels and cleans an avatar transfer at the 30-second deadline', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const cancel = jest.fn();
    const t = await seedNeedy();
    mockQuery.mockResolvedValue([contactWithPhoto]);
    MockFile.createDownloadTask.mockImplementationOnce(
      (_url: string, _destination: { uri: string }, options: { signal: AbortSignal }) => {
        let rejectDownload!: (error: Error) => void;
        options.signal.addEventListener('abort', () => {
          cancel();
          rejectDownload(new Error('native cancelled'));
        });
        return {
          cancel,
          release: jest.fn(),
          downloadAsync: () =>
            new Promise((_resolve, reject) => {
              rejectDownload = reject;
            }),
        };
      },
    );
    try {
      const run = backfillServerAvatars(t.db, http);
      for (let i = 0; i < 20 && MockFile.createDownloadTask.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(MockFile.createDownloadTask).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(SERVER_AVATAR_TIMEOUT_MS);
      await expect(run).resolves.toBe(0);

      expect(cancel).toHaveBeenCalled();
      expect(MockFile.mockDisk.size).toBe(0);
      expect(warn.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ reason: 'timeout' }));
    } finally {
      jest.useRealTimers();
    }
  });

  it('deletes a completed avatar and skips its DB write after Disconnect', async () => {
    const t = await seedNeedy();
    mockQuery.mockResolvedValue([contactWithPhoto]);
    let finishDownload!: () => void;
    MockFile.createDownloadTask.mockImplementationOnce(
      (_url: string, destination: { uri: string }) => ({
        cancel: jest.fn(),
        release: jest.fn(),
        downloadAsync: () =>
          new Promise((resolve) => {
            finishDownload = () => {
              MockFile.mockDisk.set(destination.uri, 10);
              resolve(destination);
            };
          }),
      }),
    );

    const run = backfillServerAvatars(t.db, http);
    for (let i = 0; i < 20 && finishDownload == null; i += 1) await Promise.resolve();
    expect(finishDownload).toBeDefined();

    await pauseRealtimeDeliveries();
    finishDownload();

    await expect(run).resolves.toBe(0);
    expect(MockFile.mockDeletes.some((uri) => uri.endsWith('.part'))).toBe(true);
    const avatar = (
      t.raw.prepare("SELECT avatar a FROM handles WHERE address='+15551234567'").get() as {
        a: string | null;
      }
    ).a;
    expect(avatar).toBeNull();
  });

  it('rolls back an admitted avatar commit and drains its downloaded-file cleanup', async () => {
    const t = await seedNeedy();
    mockQuery.mockResolvedValue([contactWithPhoto]);
    let current = true;
    let pausePromise: Promise<void> | undefined;
    let pauseSettled = false;
    let pauseSettledAtTrigger: boolean | undefined;
    t.raw.function('retire_during_server_avatar_commit', () => {
      current = false;
      pausePromise = pauseRealtimeDeliveries().then(() => {
        pauseSettled = true;
      });
      pauseSettledAtTrigger = pauseSettled;
      return 1;
    });
    t.raw.exec(`
      CREATE TRIGGER retire_during_server_avatar_commit
      AFTER UPDATE OF avatar ON handles
      WHEN OLD.avatar IS NULL
        AND NEW.avatar LIKE 'file:///doc/server-contact-avatars/%'
      BEGIN
        SELECT retire_during_server_avatar_commit();
      END
    `);
    const lease = { generation: 417, isCurrent: () => current };

    try {
      await expect(backfillServerAvatars(t.db, http, lease)).resolves.toBe(0);
      expect(pauseSettledAtTrigger).toBe(false);
      expect(pausePromise).toBeDefined();
      await pausePromise;
      expect(pauseSettled).toBe(true);
      expect(
        (
          t.raw.prepare("SELECT avatar FROM handles WHERE address='+15551234567'").get() as {
            avatar: string | null;
          }
        ).avatar,
      ).toBeNull();
      expect(
        MockFile.mockDeletes.some((uri) => uri.endsWith(`/${avatarFileName('c1', 'e1')}`)),
      ).toBe(true);
      expect(
        [...MockFile.mockDisk.keys()].some((uri) => uri.endsWith(`/${avatarFileName('c1', 'e1')}`)),
      ).toBe(false);
    } finally {
      await pausePromise;
      resumeRealtimeDeliveries();
    }
  });

  it('starts no server-avatar work for an initially stale account lease', async () => {
    const t = await seedNeedy();
    const staleLease = { generation: 418, isCurrent: () => false };

    await expect(backfillServerAvatars(t.db, http, staleLease)).resolves.toBe(0);

    expect(mockQuery).not.toHaveBeenCalled();
    expect(MockDirectory).not.toHaveBeenCalled();
    expect(MockFile.createDownloadTask).not.toHaveBeenCalled();
  });

  it('disowns an old delayed server-contact response after the next account opens', async () => {
    const t = await seedNeedy();
    let finishQuery!: (contacts: (typeof contactWithPhoto)[]) => void;
    mockQuery.mockReturnValueOnce(
      new Promise((resolve) => {
        finishQuery = resolve;
      }),
    );

    const oldRun = backfillServerAvatars(t.db, http);
    for (let i = 0; i < 20 && mockQuery.mock.calls.length === 0; i += 1) await Promise.resolve();
    expect(mockQuery).toHaveBeenCalledTimes(1);

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    finishQuery([contactWithPhoto]);

    await expect(oldRun).resolves.toBe(0);
    expect(MockFile.createDownloadTask).not.toHaveBeenCalled();
    const avatar = (
      t.raw.prepare("SELECT avatar a FROM handles WHERE address='+15551234567'").get() as {
        a: string | null;
      }
    ).a;
    expect(avatar).toBeNull();
  });
});
