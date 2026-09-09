import { serverInfo as fetchServerInfo } from '@core/api/endpoints/server';
import type { HttpClient, HttpTransportSnapshot } from '@core/api/http';
import type { ServerInfo } from '@core/models/serverInfo';
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

export function fixedRcsCapabilitySource(
  serverInfo: ServerInfo | null = null,
): FixedRcsCapabilitySource {
  return Object.freeze({ kind: 'fixed', serverInfo });
}

export interface RcsAttemptOwnershipResolution {
  readonly attemptAware: boolean;
  readonly serverInfo: ServerInfo | null;
}

export interface SendCapabilityResolutionOptions {
  /** Fetch an exact server-info result even for a non-RCS send. */
  readonly requireServerInfo?: boolean;
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
  return Object.freeze({
    kind: 'session',
    origin,
    revision: transport.revision,
    serverInfo: state.serverInfo,
    isCurrent: transport.isCurrent,
    publish: (info: ServerInfo): boolean =>
      useSessionStore.getState().setServerInfoForTransport(origin, transport.revision, info),
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
      throw error;
    }
    assertCurrentCapabilitySource(http, commitGuard, capabilitySource);
    if (!info) throw new Error('RCS send-attempt capability discovery returned no server info.');
    if (capabilitySource?.kind === 'session' && !capabilitySource.publish(info)) {
      throw new DbCommitGuardRejectedError();
    }
  }

  return {
    attemptAware: isRcs && info.supports_rcs_send_attempt_ownership === true,
    serverInfo: info,
  };
}
