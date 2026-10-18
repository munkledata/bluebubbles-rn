import { logger } from '@core/secure';
import { useTransportHealthStore, type TransportHealthSnapshot } from '@state/transportHealthStore';

/** The device network came back while this lifecycle's live socket was still down. */
function networkRecoveredWithSocketDown(
  state: TransportHealthSnapshot,
  previous: TransportHealthSnapshot,
): boolean {
  return (
    state.active &&
    previous.active &&
    state.generation === previous.generation &&
    previous.network === 'offline' &&
    state.network === 'online' &&
    state.socket !== 'connected' &&
    state.socket !== 'auth-rejected'
  );
}

/**
 * When the device network comes back after an outage, restart the live socket right away instead
 * of waiting out its capped reconnect backoff (up to about a minute), during which the banner kept
 * saying "Connection problem" although the server was reachable again (review M116).
 *
 * `retry` is the manual Retry seam (`retryRealtimeConnection`): it replaces only the socket,
 * cancels the pending escalation timer and re-probes the server, and does nothing unless the
 * foreground realtime owner is live. This watcher lives outside realtimeControl.ts, whose source is
 * pinned by the DB-write guard. Returns the function that stops watching.
 *
 * Known limit: a socket that deliberately stopped retrying (a rejection the server did not mark
 * retryable, or its rate-limit wait) also reads as `error`, so a network recovery overrides that
 * decision at the cost of one extra handshake.
 */
export function startNetworkRecoveryRetry(retry: () => boolean): () => void {
  let pending: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = useTransportHealthStore.subscribe((state, previous) => {
    if (pending !== null || !networkRecoveredWithSocketDown(state, previous)) return;
    const generation = state.generation;
    // Defer one tick so the network publication finishes first. The retry re-probes the server.
    pending = setTimeout(() => {
      pending = null;
      const current = useTransportHealthStore.getState();
      if (
        !current.active ||
        current.generation !== generation ||
        current.network !== 'online' ||
        current.socket === 'connected' ||
        current.socket === 'auth-rejected'
      ) {
        return;
      }
      try {
        retry();
      } catch (error) {
        logger.warn('[transport] network-recovery retry failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    }, 0);
  });
  return () => {
    unsubscribe();
    if (pending !== null) clearTimeout(pending);
    pending = null;
  };
}
