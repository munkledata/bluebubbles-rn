import { useSessionStore } from '@state/sessionStore';

/** Origin of the in-app dev fixture session (no real server). */
export const DEV_SERVER_ORIGIN = 'https://dev.local';
/** In-memory password used only by the in-app fixture shortcut. */
export const DEV_SERVER_PASSWORD = 'dev';

/**
 * True only in a dev BUILD whose session is the local fixture server — the single
 * source of truth for the "dev short-circuit" that several screens/services use to
 * bypass the real send/sync path. Previously copy-pasted in 5+ files (CS-6).
 */
export function isDevServer(): boolean {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return false;
  const session = useSessionStore.getState();
  return (
    session.status === 'connected' &&
    session.origin === DEV_SERVER_ORIGIN &&
    session.password === DEV_SERVER_PASSWORD
  );
}
