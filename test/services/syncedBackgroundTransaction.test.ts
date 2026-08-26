/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
const mockGetChat = jest.fn();
const mockDeleteNativeFile = jest.fn(async (uri: string) => {
  mockNativeStates.push({ effect: 'delete-previous', inTransaction: mockIsInTransaction() });
  mockFileBytes.delete(uri);
});
const mockPruneNativeCache = jest.fn(async () => {
  mockNativeStates.push({ effect: 'prune', inTransaction: mockIsInTransaction() });
  return {
    withinQuota: true,
    deletedFiles: 0,
    deletedBytes: 0,
    remainingFiles: 0,
    remainingBytes: 0,
  };
});
const mockFileBytes = new Map<string, number>();
const mockNativeStates: Array<{ effect: string; inTransaction: boolean }> = [];
let mockIsInTransaction = (): boolean => false;

const mockDownloadBoundedNativeFile = jest.fn(
  async ({ destination }: { destination: { uri: string } }) => {
    mockNativeStates.push({ effect: 'download', inTransaction: mockIsInTransaction() });
    mockFileBytes.set(destination.uri, 10);
    return { file: destination, bytes: 10 };
  },
);
const mockDeleteOwnedFile = jest.fn((file: { uri: string }) => {
  mockNativeStates.push({ effect: 'delete-candidate', inTransaction: mockIsInTransaction() });
  mockFileBytes.delete(file.uri);
});
const mockComputeBackgroundIsLight = jest.fn(async () => {
  mockNativeStates.push({ effect: 'luminance', inTransaction: mockIsInTransaction() });
  return null as boolean | null;
});

jest.mock('@core/api', () => ({
  chatsApi: {
    getChat: mockGetChat,
    chatBackgroundUrl: jest.fn(() => 'https://server.example/background'),
  },
}));

jest.mock('@native/boundedDownload', () => ({
  deleteNativeSyncedBackgroundCacheFile: mockDeleteNativeFile,
  pruneNativeSyncedBackgroundCache: mockPruneNativeCache,
}));

jest.mock('@/services/download/boundedNativeDownload', () => ({
  BoundedDownloadError: class BoundedDownloadError extends Error {
    constructor(readonly reason: string) {
      super(`bounded download rejected: ${reason}`);
    }
  },
  deleteOwnedFile: mockDeleteOwnedFile,
  downloadBoundedNativeFile: mockDownloadBoundedNativeFile,
}));

jest.mock('@/services/backgrounds/luminance', () => ({
  computeBackgroundIsLight: mockComputeBackgroundIsLight,
}));

jest.mock('expo-file-system', () => ({
  Paths: { cache: '/cache', document: '/documents' },
  Directory: class {
    readonly uri: string;

    constructor(...parts: Array<string | { uri: string }>) {
      const [first, ...rest] = parts.map((part) => (typeof part === 'string' ? part : part.uri));
      this.uri = `${first?.replace(/\/$/, '') ?? ''}/${rest.join('/')}`;
    }

    create(): void {}
  },
  File: class {
    readonly uri: string;

    constructor(directory: string | { uri: string }, name?: string) {
      const base = typeof directory === 'string' ? directory : directory.uri;
      this.uri = name == null ? base : `${base.replace(/\/$/, '')}/${name}`;
    }

    get exists(): boolean {
      return mockFileBytes.has(this.uri);
    }

    get size(): number {
      return mockFileBytes.get(this.uri) ?? 0;
    }
  },
}));

import type Database from 'better-sqlite3';
import type { EventDeliveryContext } from '@core/realtime';
import { Chat } from '@core/models';
import {
  getChatTheme,
  getSyncedBackgroundState,
  setSyncedBackgroundUri,
  upsertChats,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { ensureSyncedBackground } from '@/services/backgrounds/syncedBackground';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { createTestDb } from '../support/testDb';

const http = {
  snapshotTransport: () => ({ headers: {}, buildUrl: (path: string) => path }),
} as never;

interface CurrentLease {
  current: boolean;
  context: EventDeliveryContext;
}

function lease(generation: number): CurrentLease {
  const state: CurrentLease = {
    current: true,
    context: { generation, isCurrent: () => state.current },
  };
  return state;
}

function syncedUri(generation: number, channel: string): string {
  const name = `media-${encodeURIComponent(JSON.stringify(['g1', channel]))}.jpg`;
  return `/documents/synced-backgrounds/generation-${generation}/${name}`;
}

function sqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

async function seedChat(db: AppDatabase, channel: string | null, uri: string): Promise<void> {
  const chat = Chat.parse({
    guid: 'g1',
    style: 43,
    ...(channel == null ? {} : { backgroundChannelGuid: channel }),
  });
  await upsertChats(db, [chat], new Map());
  await setSyncedBackgroundUri(db, 'g1', uri);
  mockGetChat.mockResolvedValue(chat);
}

describe('synced-background guarded settlements', () => {
  let db: AppDatabase;
  let raw: Database.Database;

  beforeEach(async () => {
    resumeRealtimeDeliveries();
    ({ db, raw } = await createTestDb());
    mockIsInTransaction = () => raw.inTransaction;
    jest.clearAllMocks();
    mockFileBytes.clear();
    mockNativeStates.length = 0;
    mockComputeBackgroundIsLight.mockResolvedValue(null);
  });

  afterEach(async () => {
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    raw.close();
  });

  it('rolls back a promoted URI, deletes only its candidate, then lets a fresh request commit', async () => {
    const generation = 70;
    const previous = '/documents/synced-backgrounds/generation-69/media-old.jpg';
    const candidate = syncedUri(generation, 'CH-1');
    mockFileBytes.set(previous, 10);
    await seedChat(db, 'CH-1', previous);

    const firstLease = lease(generation);
    let drain: Promise<void> | undefined;
    let drainSettled = false;
    let candidateCleanupRanBeforeDrain = false;
    mockDeleteOwnedFile.mockImplementationOnce((file: { uri: string }) => {
      candidateCleanupRanBeforeDrain = !drainSettled;
      mockNativeStates.push({ effect: 'delete-candidate', inTransaction: raw.inTransaction });
      mockFileBytes.delete(file.uri);
    });
    raw.function('retire_synced_background_promotion', () => {
      firstLease.current = false;
      drain = pauseRealtimeDeliveries().then(() => {
        drainSettled = true;
      });
      return 0;
    });
    raw.exec(`
      CREATE TRIGGER retire_synced_background_promotion
      AFTER UPDATE OF synced_background_uri ON chats
      WHEN OLD.guid = 'g1' AND NEW.synced_background_uri = '${sqlLiteral(candidate)}'
      BEGIN
        SELECT retire_synced_background_promotion();
      END
    `);

    try {
      await ensureSyncedBackground(http, db, 'g1', firstLease.context);
      if (!drain) throw new Error('synced-background promotion did not retire its account lease');
      await drain;

      expect(await getSyncedBackgroundState(db, 'g1')).toEqual({
        channel: 'CH-1',
        uri: previous,
      });
      expect(mockFileBytes.has(previous)).toBe(true);
      expect(mockFileBytes.has(candidate)).toBe(false);
      expect(mockDeleteOwnedFile).toHaveBeenCalledWith(expect.objectContaining({ uri: candidate }));
      expect(candidateCleanupRanBeforeDrain).toBe(true);
      expect(mockDeleteNativeFile).not.toHaveBeenCalledWith(previous);
      expect(mockPruneNativeCache).not.toHaveBeenCalledWith(candidate);
      expect(mockComputeBackgroundIsLight).not.toHaveBeenCalled();

      raw.exec('DROP TRIGGER retire_synced_background_promotion');
      resumeRealtimeDeliveries();
      await ensureSyncedBackground(http, db, 'g1', lease(generation).context);

      expect((await getSyncedBackgroundState(db, 'g1'))?.uri).toBe(candidate);
      expect(mockFileBytes.has(candidate)).toBe(true);
      expect(mockDeleteNativeFile).toHaveBeenCalledWith(previous);
      expect(mockPruneNativeCache).toHaveBeenCalledWith(candidate);
      expect(mockDownloadBoundedNativeFile).toHaveBeenCalledTimes(2);
      expect(mockNativeStates.every((state) => !state.inTransaction)).toBe(true);
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS retire_synced_background_promotion');
    }
  });

  it('retains the old pointer and file when guarded removal rolls back, then clears both on retry', async () => {
    const previous = '/documents/synced-backgrounds/generation-79/media-old.jpg';
    mockFileBytes.set(previous, 10);
    await seedChat(db, null, previous);

    const firstLease = lease(80);
    let drain: Promise<void> | undefined;
    raw.function('retire_synced_background_removal', () => {
      firstLease.current = false;
      drain = pauseRealtimeDeliveries();
      return 0;
    });
    raw.exec(`
      CREATE TRIGGER retire_synced_background_removal
      AFTER UPDATE OF synced_background_uri ON chats
      WHEN OLD.guid = 'g1' AND NEW.synced_background_uri IS NULL
      BEGIN
        SELECT retire_synced_background_removal();
      END
    `);

    try {
      await ensureSyncedBackground(http, db, 'g1', firstLease.context);
      if (!drain) throw new Error('synced-background removal did not retire its account lease');
      await drain;

      expect((await getSyncedBackgroundState(db, 'g1'))?.uri).toBe(previous);
      expect(mockFileBytes.has(previous)).toBe(true);
      expect(mockDeleteNativeFile).not.toHaveBeenCalledWith(previous);

      raw.exec('DROP TRIGGER retire_synced_background_removal');
      resumeRealtimeDeliveries();
      await ensureSyncedBackground(http, db, 'g1', lease(80).context);

      expect((await getSyncedBackgroundState(db, 'g1'))?.uri).toBeNull();
      expect(mockDeleteNativeFile).toHaveBeenCalledWith(previous);
      expect(mockFileBytes.has(previous)).toBe(false);
      expect(mockNativeStates.every((state) => !state.inTransaction)).toBe(true);
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS retire_synced_background_removal');
    }
  });

  it('rolls back measured luminance on retirement and recomputes outside SQLite for a retry', async () => {
    const generation = 90;
    const currentUri = syncedUri(generation, 'CH-1');
    mockFileBytes.set(currentUri, 10);
    await seedChat(db, 'CH-1', currentUri);
    mockComputeBackgroundIsLight.mockResolvedValue(true);

    const firstLease = lease(generation);
    let drain: Promise<void> | undefined;
    raw.function('retire_synced_background_luminance', () => {
      firstLease.current = false;
      drain = pauseRealtimeDeliveries();
      return 0;
    });
    raw.exec(`
      CREATE TRIGGER retire_synced_background_luminance
      AFTER UPDATE OF background_is_light ON chats
      WHEN OLD.guid = 'g1' AND NEW.background_is_light = 1
      BEGIN
        SELECT retire_synced_background_luminance();
      END
    `);

    try {
      await ensureSyncedBackground(http, db, 'g1', firstLease.context);
      if (!drain) throw new Error('synced-background luminance did not retire its account lease');
      await drain;

      expect((await getChatTheme(db, 'g1'))?.backgroundIsLight).toBeNull();
      expect(mockDownloadBoundedNativeFile).not.toHaveBeenCalled();

      raw.exec('DROP TRIGGER retire_synced_background_luminance');
      resumeRealtimeDeliveries();
      await ensureSyncedBackground(http, db, 'g1', lease(generation).context);

      expect((await getChatTheme(db, 'g1'))?.backgroundIsLight).toBe(1);
      expect(mockComputeBackgroundIsLight).toHaveBeenCalledTimes(2);
      expect(
        mockNativeStates
          .filter((state) => state.effect === 'luminance')
          .every((state) => !state.inTransaction),
      ).toBe(true);
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS retire_synced_background_luminance');
    }
  });
});
