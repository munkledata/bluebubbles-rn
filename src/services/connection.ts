// Import from the specific module (not the @core/api barrel) to avoid pulling in
// the ky-based HttpClient — keeps this unit testable in Node without mocking ky.
import { ApiError } from '@core/api/errors';
import { MIN_SERVER_VERSION } from '@core/config';
import type { ServerInfo } from '@core/models';
import {
  ACCOUNT_REVOCATION_CLEAR_FAILURE_MESSAGE,
  logger,
  SERVER_SESSION_STATE,
  type AccountRevocationMarker,
  type SecureVault,
} from '@core/secure';
import { isAtLeast } from '@utils/version';

export type ConnectFailureKind =
  'unauthorized' | 'unreachable' | 'outdated' | 'cancelled' | 'unknown';

export type ConnectResult =
  { ok: true; serverInfo: ServerInfo } | { ok: false; kind: ConnectFailureKind; message: string };

interface CurrentAttemptDeps {
  /** False once Disconnect revokes this candidate while network/SecureStore work is suspended. */
  isAttemptCurrent?: () => boolean;
}

export interface ConnectionValidationDeps extends CurrentAttemptDeps {
  /** Performs GET /server/info against the candidate origin (throws ApiError). */
  fetchServerInfo: () => Promise<ServerInfo>;
  minServerVersion?: string;
}

export interface CredentialPersistenceDeps extends CurrentAttemptDeps {
  vault: SecureVault;
  revocationMarker: AccountRevocationMarker;
}

export type ConnectionDeps = ConnectionValidationDeps & CredentialPersistenceDeps;

function attemptIsCurrent(deps: CurrentAttemptDeps): boolean {
  return deps.isAttemptCurrent?.() !== false;
}

function cancelledResult(): ConnectResult {
  return {
    ok: false,
    kind: 'cancelled',
    message: 'Connection attempt was cancelled.',
  };
}

/**
 * Validate a candidate server origin + password and, on success, persist the
 * credentials to the secure vault. Mirrors the Flutter connect() flow
 * (server_credentials.dart): 401 → wrong password, non-200 → unreachable, then
 * gate on the minimum server version required for header auth + AEAD crypto.
 *
 * Pure orchestration: HTTP and storage are injected, so this is unit-testable
 * with a fake fetch + in-memory vault.
 */
export async function connectToServer(
  origin: string,
  password: string,
  deps: ConnectionDeps,
): Promise<ConnectResult> {
  const validation = await validateServerConnection(deps);
  if (!validation.ok) return validation;
  return persistServerConnection(origin, password, validation.serverInfo, deps);
}

/** Validate candidate credentials without changing any durable or live session state. */
export async function validateServerConnection(
  deps: ConnectionValidationDeps,
): Promise<ConnectResult> {
  const minVersion = deps.minServerVersion ?? MIN_SERVER_VERSION;

  let info: ServerInfo;
  try {
    info = await deps.fetchServerInfo();
  } catch (err) {
    return attemptIsCurrent(deps) ? mapError(err) : cancelledResult();
  }
  // Disconnect can run while the candidate request is in flight. It closes the attempt
  // synchronously; never begin durable writes from a response that belongs to that old epoch.
  if (!attemptIsCurrent(deps)) return cancelledResult();

  // Version is ADVISORY, not a hard gate. The Gator fork uses its own versioning and a
  // below-min (or version-less) server still works in a degraded mode — header auth is
  // present and rowid sync falls back to timestamps — so we warn and proceed rather than
  // block (which previously made the app unusable against Gator).
  if (info.server_version && !isAtLeast(info.server_version, minVersion)) {
    logger.warn(
      `[connect] server ${info.server_version} is below the recommended ${minVersion}; proceeding (some features may be degraded).`,
    );
  }

  return { ok: true, serverInfo: info };
}

/** Commit an already-validated candidate with the existing correlated-vault protocol. */
export async function persistServerConnection(
  origin: string,
  password: string,
  info: ServerInfo,
  deps: CredentialPersistenceDeps,
): Promise<ConnectResult> {
  // Correlate the two independent SecureStore keys. `writing` is durable BEFORE either credential
  // changes, so a crash/rejection between them cannot make a mixed old/new pair look connected.
  // `active` is the commit marker and is written only after both credential writes succeed.
  try {
    if (!attemptIsCurrent(deps)) return cancelledResult();
    await deps.vault.set('serverSessionState', SERVER_SESSION_STATE.writing);
    if (!attemptIsCurrent(deps)) return cancelledResult();
    await deps.vault.set('serverAddress', origin);
    if (!attemptIsCurrent(deps)) return cancelledResult();
    await deps.vault.set('serverPassword', password);
    if (!attemptIsCurrent(deps)) return cancelledResult();
    await deps.vault.set('serverSessionState', SERVER_SESSION_STATE.active);
    if (!attemptIsCurrent(deps)) return cancelledResult();
  } catch (err) {
    if (!attemptIsCurrent(deps)) return cancelledResult();
    logger.warn('[connect] secure credential persistence failed — session was not activated', err);
    return {
      ok: false,
      kind: 'unknown',
      message: 'Could not save the server credentials securely. Please try again.',
    };
  }

  // The independent filesystem marker is the final half of the commit. It stays present through
  // every SecureStore write, so an old disconnected account cannot become active if persistence is
  // interrupted. Only a complete `writing -> credentials -> active` tuple earns this clear.
  if (!attemptIsCurrent(deps)) return cancelledResult();
  try {
    deps.revocationMarker.clear();
  } catch (err) {
    logger.warn(
      '[connect] account revocation marker clear failed — session was not activated',
      err,
    );
    return {
      ok: false,
      kind: 'unknown',
      message: ACCOUNT_REVOCATION_CLEAR_FAILURE_MESSAGE,
    };
  }

  return { ok: true, serverInfo: info };
}

function mapError(err: unknown): ConnectResult {
  if (err instanceof ApiError) {
    switch (err.kind) {
      case 'unauthorized':
        return {
          ok: false,
          kind: 'unauthorized',
          message: 'Authentication failed — incorrect password.',
        };
      case 'no_connection':
      case 'timeout':
        return {
          ok: false,
          kind: 'unreachable',
          message:
            'Could not reach your server. Check the URL and that it is accessible from this device.',
        };
      default:
        return { ok: false, kind: 'unknown', message: err.message || 'Unexpected server error.' };
    }
  }
  return { ok: false, kind: 'unknown', message: 'Unexpected error while connecting.' };
}
