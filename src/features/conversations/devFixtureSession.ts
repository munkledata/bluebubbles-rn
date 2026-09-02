import { useSessionStore } from '@state/sessionStore';
import { DEV_SERVER_ORIGIN, DEV_SERVER_PASSWORD } from '@utils/isDev';
import { ensureDatabase } from '@/services/databaseControl';
import { getDatabase } from '@db/database';
import { recoverAttachmentCache } from '@/services/download/attachmentCacheRecovery';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { seedFixtures } from './devSeed';

let devFixtureSessionInFlight: Promise<void> | null = null;

/** Prepare and publish one local fixture session without exposing composition work to the route. */
export function startDevFixtureSession(): Promise<void> {
  if (typeof __DEV__ === 'undefined' || !__DEV__) {
    return Promise.reject(new Error('Development fixtures are unavailable in release builds.'));
  }
  if (devFixtureSessionInFlight) return devFixtureSessionInFlight;

  const attempt = (async (): Promise<void> => {
    await ensureDatabase();
    await seedFixtures();
    // Normal connected boot reopens this gate after durable-session validation. This DEV-only
    // shortcut deliberately bypasses that boot path, so mirror its cache-recovery gate before
    // publishing an inbox that offers persistent attachment downloads.
    resumeRealtimeDeliveries();
    const cacheLease = captureRealtimeDeliveryLease();
    try {
      const recovery = await recoverAttachmentCache(getDatabase(), cacheLease);
      if (recovery.status !== 'ready' || !cacheLease.isCurrent()) {
        throw new Error('Development attachment cache recovery became stale.');
      }
      useSessionStore
        .getState()
        .connected(DEV_SERVER_ORIGIN, DEV_SERVER_PASSWORD, { server_version: '1.9.0' });
    } catch (error) {
      await pauseRealtimeDeliveries();
      throw error;
    }
  })();

  devFixtureSessionInFlight = attempt;
  const clear = (): void => {
    if (devFixtureSessionInFlight === attempt) devFixtureSessionInFlight = null;
  };
  void attempt.then(clear, clear);
  return attempt;
}
