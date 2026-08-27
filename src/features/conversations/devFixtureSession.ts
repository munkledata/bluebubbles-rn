import { useSessionStore } from '@state/sessionStore';
import { DEV_SERVER_ORIGIN, DEV_SERVER_PASSWORD } from '@utils/isDev';
import { ensureDatabase } from '@/services/databaseControl';
import { resumeRealtimeDeliveries } from '@/services/realtime/deliveryCoordinator';
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
    useSessionStore
      .getState()
      .connected(DEV_SERVER_ORIGIN, DEV_SERVER_PASSWORD, { server_version: '1.9.0' });
    // Normal connected boot reopens this gate after durable-session validation. This DEV-only
    // shortcut deliberately bypasses that boot path, so reopen it only after fixtures and the
    // in-memory session have both been published successfully.
    resumeRealtimeDeliveries();
  })();

  devFixtureSessionInFlight = attempt;
  const clear = (): void => {
    if (devFixtureSessionInFlight === attempt) devFixtureSessionInFlight = null;
  };
  void attempt.then(clear, clear);
  return attempt;
}
