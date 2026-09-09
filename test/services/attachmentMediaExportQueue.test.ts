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
