import { classifyServerRotation, sanitizeServerAddress, strictServerOrigin } from '@core/config';
import { useSessionStore } from '@state/sessionStore';
import { serverRotationCoordinator } from './realtime/serverRotationCoordinator';
import { applyNewServerUrl } from './realtimeControl';

export type ServerAddressChangeRequest =
  'offered' | 'invalid' | 'same-address' | 'insecure-downgrade' | 'unverifiable' | 'unavailable';

/**
 * Offer a user-typed server address through the same approval prompt a server-sent change uses
 * (review item 800). A missed or cancelled prompt therefore never forces Disconnect, which deletes
 * local data. The prompt re-checks the password, validates the address, then saves it for the same
 * account; `unavailable` means the change could not be offered right now (not connected, locked,
 * backgrounded, a credential upgrade or another change in progress).
 */
export async function requestServerAddressChange(
  rawAddress: string,
): Promise<ServerAddressChangeRequest> {
  const session = useSessionStore.getState();
  const currentOrigin = strictServerOrigin(session.origin);
  if (!currentOrigin) return 'unavailable';
  const candidate = sanitizeServerAddress(rawAddress);
  if (!candidate) return 'invalid';
  const classification = classifyServerRotation(currentOrigin, candidate);
  if (classification.kind === 'invalid') return 'invalid';
  if (classification.kind === 'same-origin') return 'same-address';
  if (classification.kind === 'downgrade') return 'insecure-downgrade';
  // A typed address could reach a different Mac that accepts the same password. The approval checks
  // the new address reports this server's Messages-database identity, so it needs a known one.
  if (!session.serverInfo?.imessage_provider_epoch) return 'unverifiable';

  await applyNewServerUrl(classification.candidateOrigin);
  return serverRotationCoordinator.getSnapshot()?.candidateOrigin === classification.candidateOrigin
    ? 'offered'
    : 'unavailable';
}
