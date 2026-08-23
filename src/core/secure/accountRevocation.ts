/**
 * Non-secret, SecureStore-independent account revocation state.
 *
 * The production implementation lives in `src/native/` and uses one app-private file. Keeping the
 * contract in platform-free core lets boot, connection, and killed-app FCM policy run against
 * deterministic fakes in Node tests without loading Expo's native filesystem module.
 */
export interface AccountRevocationMarker {
  /** True when a previous account has been explicitly disconnected. May throw when unreadable. */
  isRevoked(): boolean;
  /** Persist revocation before attempting to retire credentials in SecureStore. */
  markRevoked(): void;
  /** Clear revocation only after a new credential tuple has been fully committed. */
  clear(): void;
}

export type AccountRevocationState = 'clear' | 'revoked' | 'unavailable';

export const ACCOUNT_REVOCATION_CLEAR_FAILURE_MESSAGE =
  'Your credentials were saved, but Gator could not safely activate this connection. Try again; if the problem continues, restart the app.';

/**
 * Read the independent marker without ever turning an I/O failure into authorization.
 *
 * `unavailable` is intentionally distinct for diagnostics, but callers must treat it exactly like
 * `revoked`: fail closed and wait for an explicit, successfully persisted connection.
 */
export function readAccountRevocationState(
  marker: Pick<AccountRevocationMarker, 'isRevoked'>,
): AccountRevocationState {
  try {
    return marker.isRevoked() ? 'revoked' : 'clear';
  } catch {
    return 'unavailable';
  }
}
