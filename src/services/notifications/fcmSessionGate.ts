import {
  hasActiveServerSession,
  readAccountRevocationState,
  type AccountRevocationMarker,
  type SecureVault,
} from '@core/secure';

export type FcmSessionState = 'active' | 'forgotten' | 'unavailable';

/**
 * Determine whether a push belongs to a fully retained account without opening the database.
 * SecureStore failures are distinct from a completed forget, but both must fail closed: normal
 * foreground/socket sync can recover a legitimate event after credentials are available again.
 */
export async function readFcmSessionState(
  vault: Pick<SecureVault, 'get'>,
  revocationMarker: Pick<AccountRevocationMarker, 'isRevoked'>,
): Promise<FcmSessionState> {
  const revocation = readAccountRevocationState(revocationMarker);
  if (revocation === 'unavailable') return 'unavailable';
  if (revocation === 'revoked') return 'forgotten';

  try {
    const [sessionState, address, password] = await Promise.all([
      vault.get('serverSessionState'),
      vault.get('serverAddress'),
      vault.get('serverPassword'),
    ]);
    return hasActiveServerSession(sessionState, address, password) ? 'active' : 'forgotten';
  } catch {
    return 'unavailable';
  }
}
