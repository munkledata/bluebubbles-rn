import { useSessionStore } from '@state/sessionStore';

/** Origin of the in-app dev fixture session (no real server). */
export const DEV_SERVER_ORIGIN = 'https://dev.local';

/**
 * True only in a dev BUILD whose session is the local fixture server — the single
 * source of truth for the "dev short-circuit" that several screens/services use to
 * bypass the real send/sync path. Previously copy-pasted in 5+ files (CS-6).
 */
export function isDevServer(): boolean {
  return (
    typeof __DEV__ !== 'undefined' &&
    __DEV__ &&
    useSessionStore.getState().origin === DEV_SERVER_ORIGIN
  );
}
