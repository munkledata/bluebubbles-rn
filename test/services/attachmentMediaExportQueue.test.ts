jest.mock('react-native', () => ({ AppState: { currentState: 'active' } }));
jest.mock('@state/featureSettingsStore', () => ({
  featureState: {
    hydrated: true,
    autoDownloadAttachments: true,
    autoDownloadDestination: 'album',
  },
  useFeatureSettingsStore: {
    getState: () =>
      (jest.requireMock('@state/featureSettingsStore') as { featureState: unknown }).featureState,
  },
}));
jest.mock('@state/lockStore', () => ({
  lockState: { locked: false },
  useLockStore: {
    getState: () => (jest.requireMock('@state/lockStore') as { lockState: unknown }).lockState,
  },
}));
jest.mock('@state/sessionStore', () => ({
  sessionState: {
    status: 'connected',
    origin: 'https://example.test',
    password: 'secret',
  },
  useSessionStore: {
    getState: () =>
      (jest.requireMock('@state/sessionStore') as { sessionState: unknown }).sessionState,
  },
}));
jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/media', () => ({
  getImageLibrarySavePermission: jest.fn(),
  saveImageToLibrary: jest.fn(),
}));
jest.mock('@db/repositories', () => ({
  ATTACHMENT_MEDIA_EXPORT_MAX_DRAIN: 8,
  claimNextAttachmentMediaExport: jest.fn(),
  completeAttachmentMediaExport: jest.fn(),
  failAttachmentMediaExport: jest.fn(),
  maintainAttachmentMediaExports: jest.fn(),
}));

import { getDatabase } from '@db/database';
import {
  claimNextAttachmentMediaExport,
  completeAttachmentMediaExport,
  failAttachmentMediaExport,
  maintainAttachmentMediaExports,
} from '@db/repositories';
import { getImageLibrarySavePermission, saveImageToLibrary } from '@/services/media';
import {
  drainPendingAttachmentMediaExports,
  fulfillAttachmentMediaExport,
} from '@/services/download/attachmentMediaExportQueue';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const appState = (
  jest.requireMock('react-native') as {
    AppState: { currentState: string | null };
  }
).AppState;
const featureState = (
  jest.requireMock('@state/featureSettingsStore') as {
    featureState: {
      hydrated: boolean;
      autoDownloadAttachments: boolean;
      autoDownloadDestination: 'app' | 'gallery' | 'album';
    };
  }
).featureState;
const lockState = (jest.requireMock('@state/lockStore') as { lockState: { locked: boolean } })
  .lockState;
const sessionState = (
  jest.requireMock('@state/sessionStore') as {
    sessionState: { status: string; origin: string | null; password: string | null };
  }
).sessionState;

const mockDb = { account: 'A' };
const mockGetDatabase = getDatabase as jest.Mock;
const mockPermission = getImageLibrarySavePermission as jest.Mock;
const mockSave = saveImageToLibrary as jest.Mock;
const mockMaintain = maintainAttachmentMediaExports as jest.Mock;
const mockClaim = claimNextAttachmentMediaExport as jest.Mock;
const mockComplete = completeAttachmentMediaExport as jest.Mock;
const mockFail = failAttachmentMediaExport as jest.Mock;

beforeEach(() => {
  // Queued mockResolvedValueOnce values a test never consumed would leak into the next one.
  for (const mock of [mockMaintain, mockPermission, mockClaim, mockComplete, mockFail, mockSave]) {
    mock.mockReset();
  }
  resumeRealtimeDeliveries();
  appState.currentState = 'active';
  featureState.hydrated = true;
  featureState.autoDownloadAttachments = true;
  featureState.autoDownloadDestination = 'album';
  lockState.locked = false;
  sessionState.status = 'connected';
  sessionState.origin = 'https://example.test';
  sessionState.password = 'secret';
  mockGetDatabase.mockReturnValue(mockDb);
  mockMaintain.mockResolvedValue(undefined);
  mockPermission.mockResolvedValue(true);
  mockClaim.mockResolvedValue(null);
  mockComplete.mockResolvedValue(true);
  mockFail.mockResolvedValue({ status: 'retry-scheduled', attempts: 1, nextAttemptAt: 10 });
  mockSave.mockResolvedValue('saved');
});

it('maintains expired work before a denied passive permission check and coalesces the flight', async () => {
  let resolvePermission!: (value: boolean) => void;
  mockPermission.mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      resolvePermission = resolve;
    }),
  );
  const lease = captureRealtimeDeliveryLease();

  const first = drainPendingAttachmentMediaExports(lease);
  const second = drainPendingAttachmentMediaExports(lease);
  expect(second).toBe(first);
  await Promise.resolve();
  expect(mockMaintain).toHaveBeenCalledTimes(1);
  resolvePermission(false);

  await expect(first).resolves.toEqual({ savedImages: 0, destination: null });
  expect(mockClaim).not.toHaveBeenCalled();
});

it('claims, saves with check-only permission, and completes one targeted receipt', async () => {
  mockClaim.mockResolvedValueOnce({
    id: 7,
    attachmentGuid: 'att-7',
    destination: 'album',
    localPath: 'file:///documents/attachments/att-7/image.jpg',
    attempts: 1,
    claimVersion: 2,
    leaseToken: 'token',
    leaseExpiresAt: 99,
  });
  const lease = captureRealtimeDeliveryLease();

  await expect(fulfillAttachmentMediaExport(mockDb as never, 'att-7', lease)).resolves.toEqual({
    savedImages: 1,
    destination: 'album',
  });
  expect(mockSave).toHaveBeenCalledWith('file:///documents/attachments/att-7/image.jpg', {
    album: true,
    permissionMode: 'check',
  });
  expect(mockComplete).toHaveBeenCalledWith(
    mockDb,
    { id: 7, claimVersion: 2, leaseToken: 'token' },
    expect.any(Function),
  );
  expect(mockFail).not.toHaveBeenCalled();
});

/** A claimed receipt for attachment `att-<id>`. */
function claimed(id: number) {
  return {
    id,
    attachmentGuid: `att-${id}`,
    destination: 'album' as const,
    localPath: `file:///documents/attachments/att-${id}/image.jpg`,
    attempts: 1,
    claimVersion: 1,
    leaseToken: `token-${id}`,
    leaseExpiresAt: 99,
  };
}

// Saving to Photos cannot be undone, so every path around that call needs its own proof (M147).
describe('failure paths around the irreversible save', () => {
  it('records a denied save and stops the drain', async () => {
    mockClaim.mockResolvedValueOnce(claimed(1)).mockResolvedValueOnce(claimed(2));
    mockSave.mockResolvedValueOnce('denied');

    await expect(
      drainPendingAttachmentMediaExports(captureRealtimeDeliveryLease()),
    ).resolves.toEqual({ savedImages: 0, destination: null });
    expect(mockFail).toHaveBeenCalledTimes(1);
    expect(mockFail).toHaveBeenCalledWith(
      mockDb,
      { id: 1, claimVersion: 1, leaseToken: 'token-1' },
      'permission-denied',
      expect.any(Function),
    );
    // Denied permission applies to every receipt: the second is never claimed or saved.
    expect(mockClaim).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('records a missing source and a native error, then saves the next receipt', async () => {
    mockClaim
      .mockResolvedValueOnce(claimed(1))
      .mockResolvedValueOnce(claimed(2))
      .mockResolvedValueOnce(claimed(3));
    mockSave
      .mockResolvedValueOnce('skipped')
      .mockResolvedValueOnce('error')
      .mockResolvedValueOnce('saved');

    await expect(
      drainPendingAttachmentMediaExports(captureRealtimeDeliveryLease()),
    ).resolves.toEqual({ savedImages: 1, destination: 'album' });
    expect(mockFail.mock.calls.map((call) => [call[1].id, call[2]])).toEqual([
      [1, 'source-missing'],
      [2, 'native-error'],
    ]);
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(mockComplete.mock.calls[0]![1]).toEqual({
      id: 3,
      claimVersion: 1,
      leaseToken: 'token-3',
    });
    // The fourth claim finds nothing left.
    expect(mockClaim).toHaveBeenCalledTimes(4);
  });

  it('does not count a save whose completion lost its claim', async () => {
    mockClaim.mockResolvedValueOnce(claimed(1));
    mockComplete.mockResolvedValueOnce(false);

    await expect(
      drainPendingAttachmentMediaExports(captureRealtimeDeliveryLease()),
    ).resolves.toEqual({ savedImages: 0, destination: null });
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockFail).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the account lease is retired',
      () => {
        // Disconnect's pause waits for this drain, so it is not awaited here.
        void pauseRealtimeDeliveries();
      },
    ],
    [
      'App Lock engages',
      () => {
        lockState.locked = true;
      },
    ],
  ])('never saves once %s between the claim and the save', async (_label, interrupt) => {
    mockClaim.mockImplementationOnce(async () => {
      interrupt();
      return claimed(1);
    });

    await expect(
      drainPendingAttachmentMediaExports(captureRealtimeDeliveryLease()),
    ).resolves.toEqual({ savedImages: 0, destination: null });
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockFail).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });
});
