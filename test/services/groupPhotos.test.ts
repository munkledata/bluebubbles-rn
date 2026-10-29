/**
 * refreshGroupPhotos: downloads each group's photo (versioned by the server's groupPhotoGuid),
 * points the chat at it with a compare-and-set, and deletes replaced or removed files. The native
 * download and the filesystem are mocked in-file; the REAL repository functions run against an
 * in-memory SQLite (createTestDb).
 */
jest.mock('expo-file-system', () => {
  const disk = new Map<string, number>();
  class MockDirectory {
    readonly uri: string;
    constructor(base: { uri: string } | string, ...names: string[]) {
      const root = typeof base === 'string' ? base : base.uri;
      this.uri = [root, ...names].join('/');
    }
    create(): void {}
  }
  class MockFile {
    readonly uri: string;
    constructor(dir: { uri: string } | string, name?: string) {
      const base = typeof dir === 'string' ? dir : dir.uri;
      this.uri = name == null ? base : `${base}/${name}`;
    }
    get exists(): boolean {
      return disk.has(this.uri);
    }
    get size(): number {
      return disk.get(this.uri) ?? 0;
    }
  }
  return {
    Paths: { document: 'file:///doc' },
    Directory: MockDirectory,
    File: MockFile,
    mockDisk: disk,
  };
});

jest.mock('../../src/services/download/boundedNativeDownload', () => {
  class BoundedDownloadError extends Error {
    constructor(readonly reason: string) {
      super(`bounded download rejected: ${reason}`);
    }
  }
  return {
    BoundedDownloadError,
    downloadBoundedNativeFile: jest.fn(),
    deleteOwnedFile: jest.fn(),
  };
});

jest.mock('@core/api', () => ({
  chatsApi: {
    chatGroupPhotoUrl: (http: { buildUrl(path: string): string }, guid: string) =>
      http.buildUrl(`/chat/${encodeURIComponent(guid)}/icon`),
  },
}));
jest.mock('../../src/services/clients', () => ({ http: {} }));
jest.mock('../../src/services/databaseControl', () => ({ ensureDatabase: jest.fn() }));

// eslint-disable-next-line import/first
import * as fileSystem from 'expo-file-system';
// eslint-disable-next-line import/first
import {
  BoundedDownloadError,
  deleteOwnedFile,
  downloadBoundedNativeFile,
} from '../../src/services/download/boundedNativeDownload';
// eslint-disable-next-line import/first
import { refreshGroupPhotos, GROUP_PHOTO_MAX_BYTES } from '@/services/backgrounds/groupPhotos';
// eslint-disable-next-line import/first
import { upsertChats } from '@db/repositories';
// eslint-disable-next-line import/first
import { captureRealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
// eslint-disable-next-line import/first
import { createTestDb } from '../support/testDb';

const disk = (fileSystem as unknown as { mockDisk: Map<string, number> }).mockDisk;
const mockDownload = downloadBoundedNativeFile as jest.Mock;
const mockDelete = deleteOwnedFile as jest.Mock;
const GROUP = 'any;+;chat-group-photo-test';

const http = {
  isTransportCurrent: () => true,
  snapshotTransport: () => ({
    headers: { Authorization: 'Bearer x' },
    buildUrl: (path: string) => `https://server/api/v1${path}`,
  }),
} as never;

function setPhoto(db: Parameters<typeof upsertChats>[0], photoGuid: string | null) {
  return upsertChats(
    db,
    [{ guid: GROUP, style: 43, participants: [], groupPhotoGuid: photoGuid }],
    new Map(),
  );
}

async function seed(photoGuid: string | null) {
  const { db, raw } = await createTestDb();
  await setPhoto(db, photoGuid);
  return { db, raw };
}

function photoUri(raw: { prepare(sql: string): { get(): unknown } }): string | null {
  return (raw.prepare('SELECT group_photo_uri AS uri FROM chats').get() as { uri: string | null })
    .uri;
}

beforeEach(() => {
  disk.clear();
  mockDownload
    .mockReset()
    .mockImplementation(async ({ destination }: { destination: { uri: string } }) => {
      disk.set(destination.uri, 1234);
      return { bytes: 1234 };
    });
  mockDelete.mockReset().mockImplementation((file: { uri: string }) => disk.delete(file.uri));
});

describe('refreshGroupPhotos', () => {
  it('downloads a new photo once and points the chat at it', async () => {
    const { db, raw } = await seed('at_0_first');
    const lease = captureRealtimeDeliveryLease();

    await expect(refreshGroupPhotos(db, http, lease)).resolves.toBe(1);
    expect(mockDownload).toHaveBeenCalledTimes(1);
    const options = mockDownload.mock.calls[0]?.[0];
    expect(options.url).toBe(`https://server/api/v1/chat/${encodeURIComponent(GROUP)}/icon`);
    expect(options.maxBytes).toBe(GROUP_PHOTO_MAX_BYTES);
    const uri = photoUri(raw);
    expect(uri).toMatch(/^file:\/\/\/doc\/group-photos\/generation-\d+\/media-.+\.jpg$/);

    // Unchanged photo id and a usable file: nothing to do.
    await expect(refreshGroupPhotos(db, http, lease)).resolves.toBe(0);
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it('replaces the file when the photo changes and deletes the old one', async () => {
    const { db, raw } = await seed('at_0_first');
    const lease = captureRealtimeDeliveryLease();
    await refreshGroupPhotos(db, http, lease);
    const first = photoUri(raw);

    await setPhoto(db, 'at_0_next');
    await expect(refreshGroupPhotos(db, http, lease)).resolves.toBe(1);
    const next = photoUri(raw);
    expect(next).not.toBe(first);
    expect(disk.has(first!)).toBe(false);
    expect(disk.has(next!)).toBe(true);
  });

  it('clears the reference and deletes the file when the photo is removed', async () => {
    const { db, raw } = await seed('at_0_first');
    const lease = captureRealtimeDeliveryLease();
    await refreshGroupPhotos(db, http, lease);
    const first = photoUri(raw);

    await setPhoto(db, null);
    await expect(refreshGroupPhotos(db, http, lease)).resolves.toBe(1);
    expect(photoUri(raw)).toBeNull();
    expect(disk.has(first!)).toBe(false);
  });

  it('skips a photo the server does not have yet (older server or not stored)', async () => {
    const { db, raw } = await seed('at_0_first');
    mockDownload.mockRejectedValueOnce(new BoundedDownloadError('missing'));

    await expect(refreshGroupPhotos(db, http, captureRealtimeDeliveryLease())).resolves.toBe(0);
    expect(photoUri(raw)).toBeNull();
  });

  it('keeps a photo change that lands mid-download and discards its own file', async () => {
    const { db, raw } = await seed('at_0_first');
    mockDownload.mockImplementationOnce(
      async ({ destination }: { destination: { uri: string } }) => {
        disk.set(destination.uri, 1234);
        await setPhoto(db, 'at_0_new');
        return { bytes: 1234 };
      },
    );

    await expect(refreshGroupPhotos(db, http, captureRealtimeDeliveryLease())).resolves.toBe(0);
    expect(photoUri(raw)).toBeNull();
    expect(disk.size).toBe(0);
  });
});
