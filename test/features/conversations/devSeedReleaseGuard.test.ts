import { getDatabase } from '@db/database';
import {
  devQueueIncomingMessageWithoutDrain,
  devResumeQueuedIncomingMessages,
  injectMessage,
} from '@features/conversations/devSeed';
import { useSessionStore } from '@state/sessionStore';
import { DEV_SERVER_ORIGIN, DEV_SERVER_PASSWORD } from '@utils/isDev';

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/download', () => ({ setAttachmentFetcher: jest.fn() }));
jest.mock('@/services/download/devFetcher', () => ({ devProgressFetcher: jest.fn() }));
jest.mock('@/services/realtimeControl', () => ({
  devPersistRealtimeEventWithoutDrain: jest.fn(),
  devPush: { inject: jest.fn() },
  devResumePersistedRealtimeEvents: jest.fn(),
}));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  runTrackedRealtimeWork: jest.fn(async () => undefined),
}));
jest.mock('@/services/send/sendService', () => ({
  generateTempGuid: jest.fn(() => 'temp-dev-seed-release-guard'),
}));

import { runTrackedRealtimeWork } from '@/services/realtime/deliveryCoordinator';

/**
 * The DEV seams (inject a fixture message, persist without draining, resume the proof row) must be
 * dead in a release build even when the session looks like the fixture server: `isDevServer()`
 * is their only gate (scanner triage A2, 2026-11-06). The positive control proves the gate is
 * really the thing under test.
 */
describe('devSeed release-build guard', () => {
  const globalDev = globalThis as { __DEV__?: boolean };
  const previousDev = globalDev.__DEV__;
  type Lease = Parameters<typeof injectMessage>[0];
  const lease = { isCurrent: () => true } as unknown as Lease;
  const seams = [
    devQueueIncomingMessageWithoutDrain,
    devResumeQueuedIncomingMessages,
    injectMessage,
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    useSessionStore.setState({
      status: 'connected',
      origin: DEV_SERVER_ORIGIN,
      password: DEV_SERVER_PASSWORD,
    });
  });
  afterAll(() => {
    globalDev.__DEV__ = previousDev;
  });

  it('does nothing in a release build, even for the fixture session', async () => {
    globalDev.__DEV__ = false;
    for (const seam of seams) await seam(lease);
    expect(runTrackedRealtimeWork).not.toHaveBeenCalled();
    expect(getDatabase).not.toHaveBeenCalled();
  });

  it('does nothing in a dev build against a real server', async () => {
    globalDev.__DEV__ = true;
    useSessionStore.setState({ origin: 'https://real.example.com' });
    for (const seam of seams) await seam(lease);
    expect(runTrackedRealtimeWork).not.toHaveBeenCalled();
    expect(getDatabase).not.toHaveBeenCalled();
  });

  it('positive control: the dev build with the fixture session does reach the account write', async () => {
    globalDev.__DEV__ = true;
    for (const seam of seams) await seam(lease);
    expect(runTrackedRealtimeWork).toHaveBeenCalledTimes(seams.length);
  });
});
