import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { DbCommitGuardRejectedError, type DbCommitGuard } from '@db/transaction';

export interface PinnedSendTransport {
  /** One origin/auth identity for capability discovery and the resulting physical send. */
  readonly http: HttpClient;
  /** Use only until the optimistic row and outgoing-queue admission commit. */
  readonly admissionGuard: DbCommitGuard;
  /** Check immediately before a post-admission network/native effect starts. */
  assertNetworkCurrent(): void;
}

/**
 * Bind a logical send to the exact approved transport present when its entry point was called.
 *
 * A same-account origin rotation deliberately does not revoke the broader account lease. The
 * separate transport revision therefore joins the DB admission guard: if A changes to B (even
 * A -> B -> A) while paste preparation, capability discovery, or the writer queue is pending, no
 * optimistic row is committed using one server's capability and another server's transport.
 */
export function pinSendTransport(
  http: HttpClient,
  accountCommitGuard?: DbCommitGuard,
): PinnedSendTransport {
  // HttpClient captures origin, credential, headers, and the optional foreground transport
  // revision synchronously. Fixed headless clients have immutable accessors and need no Zustand
  // session in order to remain pinned.
  const pinnedHttp = http.pinTransport();
  const accountCurrent = (): boolean => accountCommitGuard?.() ?? true;
  const transportCurrent = (): boolean => pinnedHttp.isTransportCurrent();

  return Object.freeze({
    http: pinnedHttp,
    admissionGuard: (): boolean => accountCurrent() && transportCurrent(),
    assertNetworkCurrent: (): void => {
      // Account loss has stronger semantics: teardown owns the durable row and its recovery.
      if (!accountCurrent()) throw new DbCommitGuardRejectedError();
      if (!transportCurrent()) {
        throw new ApiError('cancelled', 'Server connection changed before the send started');
      }
    },
  });
}
