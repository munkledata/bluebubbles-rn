import {
  readAccountRevocationState,
  SERVER_SESSION_STATE,
  type AccountRevocationMarker,
  type SecureVault,
} from '@core/secure';

/** Immutable credential identity authorized to cross foreground boot's DB/settings stages. */
export interface ForegroundSessionSnapshot {
  readonly sessionState: null | typeof SERVER_SESSION_STATE.active;
  readonly origin: string;
  readonly password: string;
}

export type DurableSessionInspection =
  | { readonly kind: 'ready'; readonly session: ForegroundSessionSnapshot }
  | { readonly kind: 'empty' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'cleanup-required' }
  | { readonly kind: 'unavailable'; readonly source: 'marker' | 'vault'; readonly error?: unknown };

interface StoredServerSession {
  readonly sessionState: string | null;
  readonly origin: string | null;
  readonly password: string | null;
}

/**
 * Inspect both durable account gates without opening the encrypted DB.
 *
 * The independent revocation marker is checked on BOTH sides of the asynchronous vault read. A
 * Disconnect that lands while Android Keystore is suspended therefore wins before the caller can
 * authorize the old account. Ready credentials are copied into a frozen, non-null snapshot so one
 * exact identity can be carried privately through boot and compared again before activation.
 */
export async function inspectDurableServerSession(
  vault: Pick<SecureVault, 'get'>,
  marker: Pick<AccountRevocationMarker, 'isRevoked'>,
): Promise<DurableSessionInspection> {
  const markerBefore = readAccountRevocationState(marker);
  if (markerBefore === 'unavailable') return { kind: 'unavailable', source: 'marker' };
  if (markerBefore === 'revoked') return { kind: 'revoked' };

  let session: StoredServerSession;
  try {
    const [sessionState, origin, password] = await Promise.all([
      vault.get('serverSessionState'),
      vault.get('serverAddress'),
      vault.get('serverPassword'),
    ]);
    session = { sessionState, origin, password };
  } catch (error) {
    return { kind: 'unavailable', source: 'vault', error };
  }

  const markerAfter = readAccountRevocationState(marker);
  if (markerAfter === 'unavailable') return { kind: 'unavailable', source: 'marker' };
  if (markerAfter === 'revoked') return { kind: 'revoked' };

  const hasOrigin = !!session.origin;
  const hasPassword = !!session.password;
  if (session.sessionState === null && !hasOrigin && !hasPassword) return { kind: 'empty' };
  if (
    (session.sessionState === null || session.sessionState === SERVER_SESSION_STATE.active) &&
    session.origin &&
    session.password
  ) {
    return {
      kind: 'ready',
      session: Object.freeze({
        sessionState: session.sessionState,
        origin: session.origin,
        password: session.password,
      }),
    };
  }

  // Interrupted writing/forgotten, partial active or legacy pairs, and unknown state values cannot
  // prove which account owns the encrypted database. They require the idempotent forget barrier.
  return { kind: 'cleanup-required' };
}

/** Runtime guard used before the coordinator retains a password-bearing session value. */
export function isForegroundSessionSnapshot(value: unknown): value is ForegroundSessionSnapshot {
  if (!value || typeof value !== 'object' || !Object.isFrozen(value)) return false;
  const candidate = value as Partial<ForegroundSessionSnapshot>;
  return (
    (candidate.sessionState === null || candidate.sessionState === SERVER_SESSION_STATE.active) &&
    typeof candidate.origin === 'string' &&
    candidate.origin.length > 0 &&
    typeof candidate.password === 'string' &&
    candidate.password.length > 0
  );
}

/** Exact identity check immediately before publishing credentials into the live session store. */
export function sameForegroundSession(
  authorized: ForegroundSessionSnapshot,
  current: ForegroundSessionSnapshot,
): boolean {
  return (
    authorized.sessionState === current.sessionState &&
    authorized.origin === current.origin &&
    authorized.password === current.password
  );
}
