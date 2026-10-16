/* eslint-disable import/first -- Native leaves are mocked before importing the real admission path. */
jest.mock('@core/api', () => ({ serverApi: { ping: jest.fn(), serverInfo: jest.fn() } }));
jest.mock('@db/database', () => ({ getDatabase: jest.fn(), ensureDatabase: jest.fn() }));
jest.mock('@/services/clients', () => {
  const { InMemoryVault } = jest.requireActual('@core/secure');
  const marker = { revoked: false, isRevoked: () => marker.revoked, clear: jest.fn() };
  return {
    vault: new InMemoryVault(),
    accountRevocationMarker: marker,
    http: { pinTransport: jest.fn() },
    candidateClient: jest.fn(),
    fixedCredentialClient: jest.fn(
      (_origin: string, _password: string, isCurrent: () => boolean) => ({
        isTransportCurrent: isCurrent,
      }),
    ),
  };
});
jest.mock('@/services/backgrounds/syncedBackground', () => ({ ensureSyncedBackground: jest.fn() }));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: jest.fn() }));
jest.mock('@/services/syncControl', () => ({ maybeResumeSync: jest.fn() }));
jest.mock('@/services/download/autoDownloadAttachments', () => ({
  autoDownloadMessageAttachmentsForRealtimeEvent: jest.fn(),
}));
jest.mock('@/services/reachability', () => ({
  probeReachabilityNow: jest.fn(),
  startReachabilityWatch: jest.fn(),
  stopReachabilityWatch: jest.fn(),
}));
jest.mock('@/services/notifications/notifeeService', () => ({
  postNotification: jest.fn(),
  getNotificationPermissionState: jest.fn(async () => 'granted'),
}));

import { serverApi } from '@core/api';
import { type InMemoryVault, SERVER_SESSION_STATE } from '@core/secure';
import { useLockStore } from '@state/lockStore';
import { useSessionStore } from '@state/sessionStore';
import { resolveAuthorizedRealtimeTransport } from '@/services/background/authorizedRealtimeTransport';
import { ensureDatabase } from '@/services/databaseControl';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { DurableRealtimeDispatcher } from '@/services/realtime/incomingEventDispatcher';
import { persistAuthenticatedLockedFcmV3Event } from '@/services/realtimeControl';

const { vault, accountRevocationMarker: marker } = jest.requireMock('@/services/clients') as {
  vault: InMemoryVault;
  accountRevocationMarker: { revoked: boolean };
};
const openDatabase = jest.mocked(ensureDatabase);

const occurrence = () => ({
  serverEventId: 'fcm3:locked-cold-regression',
  receivedAt: Date.now(),
  authenticatedExpiresAt: Date.now() + 300_000,
});

beforeEach(async () => {
  jest.clearAllMocks();
  resumeRealtimeDeliveries();
  marker.revoked = false;
  useSessionStore.setState(useSessionStore.getInitialState(), true);
  useLockStore.setState(useLockStore.getInitialState(), true);
  await vault.set('serverSessionState', SERVER_SESSION_STATE.active);
  await vault.set('serverAddress', 'https://locked.example');
  await vault.set('serverPassword', 'synthetic-locked-credential');
  await vault.set('appLockEnabled', 'true');
  openDatabase.mockReset();
  openDatabase.mockResolvedValue({ name: 'native-db-stub' } as never);
});

afterEach(() => {
  jest.restoreAllMocks();
  useSessionStore.setState(useSessionStore.getInitialState(), true);
  useLockStore.setState(useLockStore.getInitialState(), true);
  resumeRealtimeDeliveries();
});

it('admits a locked V3 test from cold store defaults without authorizing ordinary background work', async () => {
  const context = captureRealtimeDeliveryLease();
  const persist = jest
    .spyOn(DurableRealtimeDispatcher.prototype, 'persistLockedFcmV3WithoutDrain')
    .mockResolvedValue({ status: 'enqueued', id: 1 });

  await expect(resolveAuthorizedRealtimeTransport(context.generation)).resolves.toBeUndefined();
  await expect(
    persistAuthenticatedLockedFcmV3Event('test-notification', {}, context, occurrence()),
  ).resolves.toBe('enqueued');

  expect(persist).toHaveBeenCalledTimes(1);
  expect(serverApi.serverInfo).not.toHaveBeenCalled();
  expect(useSessionStore.getState()).toMatchObject({
    status: 'loading',
    origin: null,
    password: null,
  });
  expect(useLockStore.getState()).toMatchObject({ enabled: false, locked: false, hydrated: false });
});

it('rejects the locked delivery before opening the database when the durable account is revoked', async () => {
  marker.revoked = true;
  const persist = jest.spyOn(DurableRealtimeDispatcher.prototype, 'persistLockedFcmV3WithoutDrain');

  await expect(
    persistAuthenticatedLockedFcmV3Event(
      'test-notification',
      {},
      captureRealtimeDeliveryLease(),
      occurrence(),
    ),
  ).resolves.toBe('not-enqueued');

  expect(openDatabase).not.toHaveBeenCalled();
  expect(persist).not.toHaveBeenCalled();
});

it.each(['generation', 'transport revision', 'revocation', 'lock owner'] as const)(
  'rejects a locked commit when its %s changes during database open',
  async (change) => {
    const lease = captureRealtimeDeliveryLease();
    let lockOwnerCurrent = true;
    const context = { ...lease, isCurrent: () => lease.isCurrent() && lockOwnerCurrent };
    let enteredDatabase!: () => void;
    let releaseDatabase!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredDatabase = resolve;
    });
    openDatabase.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDatabase = () => resolve({ name: 'native-db-stub' } as never);
          enteredDatabase();
        }),
    );
    const persist = jest.spyOn(
      DurableRealtimeDispatcher.prototype,
      'persistLockedFcmV3WithoutDrain',
    );
    const admission = persistAuthenticatedLockedFcmV3Event(
      'test-notification',
      {},
      context,
      occurrence(),
    );
    await entered;
    if (change === 'generation') pauseRealtimeDeliveries();
    if (change === 'transport revision') {
      useSessionStore.setState((state) => ({ transportRevision: state.transportRevision + 1 }));
    }
    if (change === 'revocation') marker.revoked = true;
    if (change === 'lock owner') lockOwnerCurrent = false;
    releaseDatabase();

    await expect(admission).resolves.toBe('not-enqueued');
    expect(persist).not.toHaveBeenCalled();
  },
);
