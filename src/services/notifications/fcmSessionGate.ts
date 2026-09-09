import {
  readAccountRevocationState,
  resolveCredentialUpgrade,
  SERVER_SESSION_STATE,
  type AccountRevocationMarker,
  type SecureVault,
} from '@core/secure';

export type FcmSessionState = 'active' | 'forgotten' | 'unavailable';

/**
 * Determine whether a push belongs to a fully retained account without opening the database.
 * SecureStore failures are distinct from a completed forget, but both must fail closed. Normal
 * foreground/socket sync may recover server-backed state after credentials return, but cannot
 * recreate a one-time event such as message-send-error.
 */
export async function readFcmSessionState(
  vault: Pick<SecureVault, 'get'>,
  revocationMarker: Pick<AccountRevocationMarker, 'isRevoked'>,
): Promise<FcmSessionState> {
  const revocation = readAccountRevocationState(revocationMarker);
  if (revocation === 'unavailable') return 'unavailable';
  if (revocation === 'revoked') return 'forgotten';

  try {
    const [sessionState, address, password, credentialUpgrade] = await Promise.all([
      vault.get('serverSessionState'),
      vault.get('serverAddress'),
      vault.get('serverPassword'),
      vault.get('serverCredentialUpgrade'),
    ]);
    const revocationAfter = readAccountRevocationState(revocationMarker);
    if (revocationAfter === 'unavailable') return 'unavailable';
    if (revocationAfter === 'revoked') return 'forgotten';

    const completeSession =
      (sessionState === null || sessionState === SERVER_SESSION_STATE.active) &&
      address &&
      password;
    const upgrade = resolveCredentialUpgrade(
      credentialUpgrade,
      completeSession ? { origin: address!, credential: password! } : null,
    );
    if (upgrade.kind === 'quarantined') return 'unavailable';
    if (upgrade.kind === 'revoked') return 'forgotten';
    return completeSession && upgrade.session ? 'active' : 'forgotten';
  } catch {
    return 'unavailable';
  }
}
