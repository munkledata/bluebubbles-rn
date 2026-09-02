import { getDatabase } from '@db/database';
import { startDevFixtureSession } from '@features/conversations/devFixtureSession';
import { ensureDatabase } from '@/services/databaseControl';
import { recoverAttachmentCache } from '@/services/download/attachmentCacheRecovery';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { seedFixtures } from '@features/conversations/devSeed';

const mockDb = { __db: true };
const mockLease = { generation: 7, isCurrent: jest.fn(() => true) };
const mockConnected = jest.fn();

jest.mock('@db/database', () => ({ getDatabase: jest.fn(() => mockDb) }));
jest.mock('@state/sessionStore', () => ({
  useSessionStore: { getState: () => ({ connected: mockConnected }) },
}));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: jest.fn() }));
jest.mock('@/services/download/attachmentCacheRecovery', () => ({
  recoverAttachmentCache: jest.fn(),
}));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: jest.fn(() => mockLease),
  pauseRealtimeDeliveries: jest.fn(),
  resumeRealtimeDeliveries: jest.fn(),
}));
jest.mock('@features/conversations/devSeed', () => ({ seedFixtures: jest.fn() }));
jest.mock('@utils/isDev', () => ({
  DEV_SERVER_ORIGIN: 'https://dev.gator.invalid',
  DEV_SERVER_PASSWORD: 'dev-password',
}));

const mockEnsureDatabase = ensureDatabase as jest.Mock;
const mockGetDatabase = getDatabase as jest.Mock;
const mockRecoverAttachmentCache = recoverAttachmentCache as jest.Mock;
const mockCaptureLease = captureRealtimeDeliveryLease as jest.Mock;
const mockPauseDeliveries = pauseRealtimeDeliveries as jest.Mock;
const mockResumeDeliveries = resumeRealtimeDeliveries as jest.Mock;
const mockSeedFixtures = seedFixtures as jest.Mock;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for the DEV fixture session checkpoint.');
}

describe('DEV fixture session cache recovery', () => {
  const previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;

  beforeAll(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockLease.isCurrent.mockReturnValue(true);
    mockEnsureDatabase.mockResolvedValue(undefined);
    mockGetDatabase.mockReturnValue(mockDb);
    mockCaptureLease.mockReturnValue(mockLease);
    mockPauseDeliveries.mockResolvedValue(undefined);
    mockSeedFixtures.mockResolvedValue(10);
  });

  afterAll(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
  });

  it('awaits ready cache recovery before publishing the connected session', async () => {
    const recovery = deferred<{ status: 'ready' }>();
    mockRecoverAttachmentCache.mockReturnValueOnce(recovery.promise);

    const session = startDevFixtureSession();
    await waitFor(() => mockRecoverAttachmentCache.mock.calls.length === 1);

    expect(mockResumeDeliveries).toHaveBeenCalledTimes(1);
    expect(mockRecoverAttachmentCache).toHaveBeenCalledWith(mockDb, mockLease);
    expect(mockConnected).not.toHaveBeenCalled();

    recovery.resolve({ status: 'ready' });
    await expect(session).resolves.toBeUndefined();

    expect(mockConnected).toHaveBeenCalledWith('https://dev.gator.invalid', 'dev-password', {
      server_version: '1.9.0',
    });
    expect(mockPauseDeliveries).not.toHaveBeenCalled();
  });

  it('awaits failure cleanup, does not connect, and permits a successful retry', async () => {
    const paused = deferred<void>();
    mockRecoverAttachmentCache
      .mockResolvedValueOnce({ status: 'stale' })
      .mockResolvedValueOnce({ status: 'ready' });
    mockPauseDeliveries.mockReturnValueOnce(paused.promise);

    const failed = startDevFixtureSession();
    let settled = false;
    void failed.catch(() => {
      settled = true;
    });
    await waitFor(() => mockPauseDeliveries.mock.calls.length === 1);

    expect(mockPauseDeliveries).toHaveBeenCalledTimes(1);
    expect(mockConnected).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    paused.resolve();
    await expect(failed).rejects.toThrow('Development attachment cache recovery became stale.');
    expect(mockConnected).not.toHaveBeenCalled();

    await expect(startDevFixtureSession()).resolves.toBeUndefined();
    expect(mockRecoverAttachmentCache).toHaveBeenCalledTimes(2);
    expect(mockPauseDeliveries).toHaveBeenCalledTimes(1);
    expect(mockConnected).toHaveBeenCalledTimes(1);
  });
});
