import type { HttpClient } from '@core/api';
import { readAccountRevocationState } from '@core/secure';
import { useSessionStore } from '@state/sessionStore';
import { accountRevocationMarker, fixedCredentialClient, http, vault } from '../clients';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';
import { inspectBackgroundSession } from './backgroundSyncOrchestrator';

export interface AuthorizedRealtimeTransport {
  readonly http: HttpClient;
  readonly lease: RealtimeDeliveryLease;
}

/**
 * Resolve one immutable, currently authorized transport for a detached realtime network effect.
 *
 * A warm process pins the connected session so a tunnel/account rotation cancels the effect. A
 * fresh killed-process FCM wake has no hydrated Zustand session, so it re-authorizes the durable
 * vault tuple and binds it to both the in-process account generation and the independent revocation
 * marker. Neither path publishes durable credentials into foreground state.
 */
export async function resolveAuthorizedRealtimeTransport(
  expectedAccountGeneration?: number,
): Promise<AuthorizedRealtimeTransport | undefined> {
  // Capture before the first await. Disconnect permanently invalidates this generation even if the
  // user immediately reconnects to the same origin with the same password.
  const accountLease = captureRealtimeDeliveryLease();
  if (
    !accountLease.isCurrent() ||
    (expectedAccountGeneration !== undefined &&
      accountLease.generation !== expectedAccountGeneration)
  ) {
    return undefined;
  }

  const session = useSessionStore.getState();
  const capturedTransportRevision = session.transportRevision;
  if (
    session.status === 'connected' &&
    session.origin &&
    session.password &&
    Number.isSafeInteger(session.transportRevision)
  ) {
    const taskHttp = http.pinTransport();
    const snapshot = taskHttp.snapshotTransport();
    const origin = session.origin;
    const password = session.password;
    const revision = session.transportRevision;
    const lease: RealtimeDeliveryLease = Object.freeze({
      generation: accountLease.generation,
      isCurrent: (): boolean => {
        const current = useSessionStore.getState();
        return (
          accountLease.isCurrent() &&
          taskHttp.isTransportCurrent() &&
          current.status === 'connected' &&
          current.origin === origin &&
          current.password === password &&
          current.transportRevision === revision
        );
      },
    });
    if (
      snapshot.origin !== origin ||
      snapshot.password !== password ||
      snapshot.transportRevision !== revision ||
      !lease.isCurrent()
    ) {
      return undefined;
    }
    return Object.freeze({ http: taskHttp, lease });
  }

  const inspection = await inspectBackgroundSession(vault, accountRevocationMarker);
  if (!accountLease.isCurrent() || inspection.kind !== 'ready') return undefined;

  const durableSessionIsCurrent = (): boolean =>
    accountLease.isCurrent() &&
    useSessionStore.getState().transportRevision === capturedTransportRevision &&
    readAccountRevocationState(accountRevocationMarker) === 'clear';
  const taskHttp = fixedCredentialClient(
    inspection.session.origin,
    inspection.session.password,
    durableSessionIsCurrent,
  );
  const lease: RealtimeDeliveryLease = Object.freeze({
    generation: accountLease.generation,
    isCurrent: (): boolean => durableSessionIsCurrent() && taskHttp.isTransportCurrent(),
  });
  return lease.isCurrent() ? Object.freeze({ http: taskHttp, lease }) : undefined;
}
