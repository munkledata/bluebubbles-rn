// Import from the specific module (not the @core/api barrel) to avoid pulling in
// the ky-based HttpClient — keeps this unit testable in Node without mocking ky.
import { ApiError } from '@core/api/errors';
import { MIN_SERVER_VERSION } from '@core/config';
import type { ServerInfo } from '@core/models';
import { logger, type SecureVault } from '@core/secure';
import { isAtLeast } from '@utils/version';

export type ConnectFailureKind = 'unauthorized' | 'unreachable' | 'outdated' | 'unknown';

export type ConnectResult =
  | { ok: true; serverInfo: ServerInfo }
  | { ok: false; kind: ConnectFailureKind; message: string };

export interface ConnectionDeps {
  /** Performs GET /server/info against the candidate origin (throws ApiError). */
  fetchServerInfo: () => Promise<ServerInfo>;
  vault: SecureVault;
  minServerVersion?: string;
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
  const minVersion = deps.minServerVersion ?? MIN_SERVER_VERSION;

  let info: ServerInfo;
  try {
    info = await deps.fetchServerInfo();
  } catch (err) {
    return mapError(err);
  }

  // Version is ADVISORY, not a hard gate. The Gator fork uses its own versioning and a
  // below-min (or version-less) server still works in a degraded mode — header auth is
  // present and rowid sync falls back to timestamps — so we warn and proceed rather than
  // block (which previously made the app unusable against Gator).
  if (info.server_version && !isAtLeast(info.server_version, minVersion)) {
    logger.warn(
      `[connect] server ${info.server_version} is below the recommended ${minVersion}; proceeding (some features may be degraded).`,
    );
  }

  // Validated — persist credentials securely (replaces plaintext SharedPreferences).
  await deps.vault.set('serverAddress', origin);
  await deps.vault.set('serverPassword', password);

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
