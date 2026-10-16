/**
 * The send-capability lease and resolver for every server-gated action, not only RCS. The "Rcs"
 * names predate their wider use: Apple-account actions (group rename and participants, remote
 * delete, FaceTime) capture the same lease to prove which server, transport revision and capability
 * set a request was admitted under. Renaming them would re-pin several send-path certificates for no
 * behavior change, so the names stay (review M201).
 */
import { serverInfo as fetchServerInfo } from '@core/api/endpoints/server';
import type { HttpClient, HttpTransportSnapshot } from '@core/api/http';
import { serverSendCapabilityKey, type ServerInfo } from '@core/models/serverInfo';
import { isCurrentRcsChatGuid } from '@core/rcs/providerIdentity';
import type { MessageTargetServerAuthorization } from '@db/repositories';
import { DbCommitGuardRejectedError, type DbCommitGuard } from '@db/transaction';
import { captureSessionTransportLease, useSessionStore } from '@state/sessionStore';
import { isRcsChatGuid } from '@utils';

function assertCurrentAccount(commitGuard?: DbCommitGuard): void {
  if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();
}

/** Explicit foreground cache provenance. Headless callers deliberately omit this lease. */
export interface RcsCapabilityLease {
  readonly kind: 'session';
  readonly origin: string;
  readonly revision: number;
  readonly serverInfo: ServerInfo | null;
  isCurrent(): boolean;
  publish(info: ServerInfo): boolean;
}

export interface FixedRcsCapabilitySource {
  readonly kind: 'fixed';
  readonly serverInfo: ServerInfo | null;
}

/** Session cache provenance or already-proven task-local capability data. */
export type RcsCapabilitySource = RcsCapabilityLease | FixedRcsCapabilitySource;

/**
 * RCS capability could not be proven for this physical send. This is temporary work starvation,
 * not a failed delivery attempt: scheduled and queued owners may safely leave their durable work
 * pending until the bridge/server-info boundary is available again.
 */
export class RcsCapabilityUnavailableError extends Error {
  constructor(
    message = 'RCS capability is unavailable.',
    readonly originalError?: unknown,
  ) {
    super(message);
    this.name = 'RcsCapabilityUnavailableError';
  }
}

export function fixedRcsCapabilitySource(
  serverInfo: ServerInfo | null = null,
): FixedRcsCapabilitySource {
  return Object.freeze({
    kind: 'fixed',
    serverInfo,
  });
}

export interface RcsAttemptOwnershipResolution {
  readonly attemptAware: boolean;
  readonly serverInfo: ServerInfo | null;
}

export interface SendCapabilityResolutionOptions {
  /** Fetch an exact server-info result even for a non-RCS send. */
  readonly requireServerInfo?: boolean;
}

/** Keep a capability-derived decision valid through a DB commit or network-start boundary. */
export function sendCapabilityCommitGuard(
  accountGuard: DbCommitGuard | undefined,
  source?: RcsCapabilitySource,
): DbCommitGuard {
  return () => (accountGuard?.() ?? true) && (source?.kind !== 'session' || source.isCurrent());
}

/** Only a completed response from a known older server authorizes the part-zero compatibility. */
export function allowsLegacyMessagePartZero(info: ServerInfo | null | undefined): boolean {
  return info != null && info.supports_message_part_topology !== true;
}

/**
 * Turn one non-null ServerInfo result into the revision/account-bound proof required by durable
 * target admission. A missing result stays unknown so recovery can defer instead of retiring work.
 */
export function messageTargetServerAuthorization(
  info: ServerInfo | null | undefined,
  isCurrent: () => boolean,
): MessageTargetServerAuthorization | undefined {
  if (!info) return undefined;
  return Object.freeze({
    allowsLegacyPartZero: allowsLegacyMessagePartZero(info),
    isCurrent,
  });
}

/** Keep a capability-derived DB decision valid through the transaction's final pre-commit fence. */
export function messageTargetCommitGuard(
  accountGuard: DbCommitGuard | undefined,
  authorization: MessageTargetServerAuthorization | undefined,
): DbCommitGuard | undefined {
  if (!authorization) return accountGuard;
  return () => (accountGuard?.() ?? true) && authorization.isCurrent();
}

/**
 * Capture the foreground server-info cache only when a complete connected session exists.
 * A fresh killed-process task gets `undefined` and must use its own fixed HttpClient instead.
 */
export function captureSessionRcsCapabilityLease(): RcsCapabilityLease | undefined {
  const state = useSessionStore.getState();
  if (state.status !== 'connected' || !state.origin || !state.password) return undefined;
  const transport = captureSessionTransportLease();
  const origin = state.origin;
  let ownedServerInfo = state.serverInfo;
  let ownedCapabilityRevision = state.sendCapabilityRevision;
  return Object.freeze({
    kind: 'session',
    origin,
    revision: transport.revision,
    get serverInfo(): ServerInfo | null {
      return ownedServerInfo;
    },
    isCurrent: (): boolean =>
      transport.isCurrent() &&
      useSessionStore.getState().sendCapabilityRevision === ownedCapabilityRevision,
    publish: (info: ServerInfo): boolean => {
      const previousInfo = ownedServerInfo;
      const previousRevision = ownedCapabilityRevision;
      const expectedRevision =
        previousRevision +
        (serverSendCapabilityKey(previousInfo) === serverSendCapabilityKey(info) ? 0 : 1);
      ownedServerInfo = info;
      ownedCapabilityRevision = expectedRevision;
      if (useSessionStore.getState().setServerInfoForTransport(origin, transport.revision, info)) {
        return true;
      }
      ownedServerInfo = previousInfo;
      ownedCapabilityRevision = previousRevision;
      return false;
    },
  });
}

function transportIdentityMatchesLease(
  transport: HttpTransportSnapshot,
  lease: RcsCapabilityLease,
): boolean {
  return transport.origin === lease.origin && transport.transportRevision === lease.revision;
}

function assertCurrentCapabilitySource(
  http: HttpClient,
  commitGuard: DbCommitGuard,
  source?: RcsCapabilitySource,
): void {
  assertCurrentAccount(commitGuard);
  if (
    source?.kind === 'session' &&
    (!source.isCurrent() || !transportIdentityMatchesLease(http.snapshotTransport(), source))
  ) {
    throw new DbCommitGuardRejectedError();
  }
}

/**
 * Decide whether a new outgoing message should use durable RCS attempt ownership.
 *
 * A hydrated session can briefly have credentials but no cached server-info response. Treating
 * that gap as "unsupported" permanently creates a legacy generation-zero send even when the
 * server supports exact attempt correlation. RCS sends therefore discover the capability before
 * creating their optimistic DB row. A completed response with no flag is still a known legacy
 * server; only an unavailable response is an unsafe unknown and is allowed to reject the send.
 */
export async function resolveRcsAttemptOwnership(
  http: HttpClient,
  chatGuid: string,
  commitGuard: DbCommitGuard,
  capabilitySource?: RcsCapabilitySource,
  options?: SendCapabilityResolutionOptions,
): Promise<RcsAttemptOwnershipResolution> {
  assertCurrentCapabilitySource(http, commitGuard, capabilitySource);
  let info = capabilitySource?.serverInfo ?? null;
  const isRcs = isRcsChatGuid(chatGuid);
  if (!isRcs && options?.requireServerInfo !== true) {
    return { attemptAware: false, serverInfo: info };
  }

  if (!info) {
    try {
      info = await fetchServerInfo(http);
    } catch (error) {
      // Prefer the ownership error when Disconnect happened during discovery. That prevents the
      // retired account's network failure from being presented as a current-account send failure.
      assertCurrentCapabilitySource(http, commitGuard, capabilitySource);
      if (isRcs) {
        throw new RcsCapabilityUnavailableError(
          error instanceof Error ? error.message : 'RCS capability discovery failed.',
          error,
        );
      }
      throw error;
    }
    assertCurrentCapabilitySource(http, commitGuard, capabilitySource);
    if (!info) {
      throw new RcsCapabilityUnavailableError(
        'RCS send-attempt capability discovery returned no server info.',
      );
    }
    if (capabilitySource?.kind === 'session' && !capabilitySource.publish(info)) {
      throw new DbCommitGuardRejectedError();
    }
  }

  // A bare `RCS;-;<source id>` survives in local history for display, but it is not a safe remote
  // target: Google can reuse that source id after a re-pair. The same is true for a qualified id
  // from an older epoch. Reject before optimistic DB admission or a network/native send starts.
  if (isRcs && !isCurrentRcsChatGuid(info, chatGuid)) {
    throw new RcsCapabilityUnavailableError(
      'This RCS conversation belongs to an unavailable or previous Google pairing.',
    );
  }

  return {
    attemptAware: isRcs && info.supports_rcs_send_attempt_ownership === true,
    serverInfo: info,
  };
}
