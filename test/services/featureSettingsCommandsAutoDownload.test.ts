jest.mock('@db/database', () => ({ getDatabase: jest.fn(() => ({ account: 'A' })) }));
jest.mock('@state/featureSettingsStore', () => {
  const state = {
    autoDownloadDestination: 'app',
    setFlag: jest.fn(async () => undefined),
    setAutoDownloadDestination: jest.fn(
      async (destination: 'app' | 'gallery' | 'album', context: { shouldCommit(): boolean }) => {
        if (context.shouldCommit()) state.autoDownloadDestination = destination;
      },
    ),
  };
  return {
    completePermissionOnboarding: jest.fn(),
    featureSettingsState: state,
    useFeatureSettingsStore: { getState: () => state },
  };
});
jest.mock('@/services/media', () => ({ requestImageLibrarySavePermission: jest.fn() }));
jest.mock('@/services/download/attachmentMediaExportQueue', () => ({
  drainPendingAttachmentMediaExports: jest.fn(async () => ({
    savedImages: 0,
    destination: null,
  })),
}));

import { requestImageLibrarySavePermission } from '@/services/media';
import { drainPendingAttachmentMediaExports } from '@/services/download/attachmentMediaExportQueue';
import {
  setAttachmentAutoDownloadDestination,
  setAttachmentAutoDownloadEnabled,
} from '@/services/featureSettingsCommands';
import {
  captureRealtimeDeliveryLease,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

interface MockFeatureState {
  autoDownloadDestination: 'app' | 'gallery' | 'album';
  setFlag: jest.Mock;
  setAutoDownloadDestination: jest.Mock;
}

const state = (
  jest.requireMock('@state/featureSettingsStore') as {
    featureSettingsState: MockFeatureState;
  }
).featureSettingsState;
const mockPermission = requestImageLibrarySavePermission as jest.Mock;
const mockDrain = drainPendingAttachmentMediaExports as jest.Mock;

function deferredBoolean(): { promise: Promise<boolean>; resolve(value: boolean): void } {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForPermissionRequest(): Promise<void> {
  for (let turn = 0; turn < 20 && mockPermission.mock.calls.length === 0; turn += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  if (mockPermission.mock.calls.length === 0) {
    throw new Error('permission request did not start within 20 event-loop turns');
  }
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  state.autoDownloadDestination = 'app';
  state.setFlag.mockClear();
  state.setAutoDownloadDestination.mockClear();
});

it('lets App supersede an older external choice still waiting on permission', async () => {
  const permission = deferredBoolean();
  mockPermission.mockReturnValueOnce(permission.promise);
  const lease = captureRealtimeDeliveryLease();

  const older = setAttachmentAutoDownloadDestination('gallery', lease);
  await waitForPermissionRequest();
  expect(mockPermission).toHaveBeenCalledTimes(1);
  await expect(setAttachmentAutoDownloadDestination('app', lease)).resolves.toBe('updated');
  permission.resolve(true);

  await expect(older).resolves.toBe('stale');
  expect(state.setAutoDownloadDestination).not.toHaveBeenCalled();
  expect(mockDrain).not.toHaveBeenCalled();
  expect(state.autoDownloadDestination).toBe('app');
});

it('retains pending receipts when permission is granted for the unchanged destination', async () => {
  state.autoDownloadDestination = 'album';
  mockPermission.mockResolvedValueOnce(true);
  const lease = captureRealtimeDeliveryLease();

  await expect(setAttachmentAutoDownloadDestination('album', lease)).resolves.toBe('updated');

  expect(mockPermission).toHaveBeenCalledTimes(1);
  // This store command also cancels pending receipts, so an unchanged destination must skip it.
  expect(state.setAutoDownloadDestination).not.toHaveBeenCalled();
  expect(mockDrain).toHaveBeenCalledWith(lease);
});

it('lets Off supersede an older external permission continuation', async () => {
  const permission = deferredBoolean();
  mockPermission.mockReturnValueOnce(permission.promise);
  const lease = captureRealtimeDeliveryLease();

  const older = setAttachmentAutoDownloadDestination('album', lease);
  await waitForPermissionRequest();
  await setAttachmentAutoDownloadEnabled(false, lease);
  permission.resolve(true);

  await expect(older).resolves.toBe('stale');
  expect(state.setFlag).toHaveBeenCalledWith(
    'autoDownloadAttachments',
    false,
    expect.objectContaining({ shouldCommit: expect.any(Function) }),
  );
  expect(state.setAutoDownloadDestination).not.toHaveBeenCalled();
});
