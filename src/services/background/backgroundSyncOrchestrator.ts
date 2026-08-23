import { strictServerOrigin } from '@core/config';
import {
  readAccountRevocationState,
  SERVER_SESSION_STATE,
  type AccountRevocationMarker,
  type SecureVault,
} from '@core/secure';

export interface BackgroundAccountScope {
  readonly generation: number;
  isCurrent(): boolean;
}

export interface BackgroundSession {
  origin: string;
  password: string;
}

export type BackgroundSessionInspection =
  | { kind: 'ready'; session: BackgroundSession }
  | { kind: 'empty' }
  | { kind: 'locked' }
  | { kind: 'unsafe' }
  | { kind: 'revoked' }
  | { kind: 'unavailable' };

export type BackgroundRunOutcome =
  | {
      result: 'success';
      reason:
        | 'completed'
        | 'no-session'
        | 'app-locked'
        | 'unsafe-session'
        | 'revoked'
        | 'account-changed';
    }
  | { result: 'retry'; reason: 'durable-state-unavailable' | 'work-failed' };

export interface BackgroundSyncDependencies<Database, Client, ServerInfo> {
  vault: Pick<SecureVault, 'get'>;
  revocationMarker: Pick<AccountRevocationMarker, 'isRevoked'>;
  captureAccountScope(): BackgroundAccountScope;
  /** Publishes the complete auth/DB/sync bootstrap into Disconnect's sync drain before it starts. */
  runTrackedSync(run: () => Promise<void>): Promise<void>;
  createClient(session: BackgroundSession): Client;
  openDatabase(): Promise<Database>;
  fetchServerInfo(client: Client): Promise<ServerInfo>;
  serverVersion(info: ServerInfo): string;
  synchronize(
    db: Database,
    client: Client,
    serverVersion: string,
    scope: BackgroundAccountScope,
  ): Promise<void>;
  recoverAndDrainSchedules(
    db: Database,
    client: Client,
    scope: BackgroundAccountScope,
  ): Promise<void>;
  drainOutgoing(db: Database, client: Client, scope: BackgroundAccountScope): Promise<void>;
  /** Best-effort only. The production implementation proves durable consent before uploading. */
  flushDiagnostics?(
    db: Database,
    client: Client,
    info: ServerInfo,
    scope: BackgroundAccountScope,
  ): Promise<void>;
  onWorkError?(error: unknown): void;
  onDiagnosticsError?(error: unknown): void;
}

/**
 * Inspect every durable pre-DB gate used by a killed/fresh background process.
 *
 * The revocation marker brackets the asynchronous Keystore read. A Disconnect that lands while
 * SecureStore is suspended therefore wins before the caller can create a client or open the DB.
 * A fresh process has no trustworthy unlock grace: persisted `appLockEnabled=true` is always
 * locked, while a missing key is the backwards-compatible "lock disabled" state.
 */
export async function inspectBackgroundSession(
  vault: Pick<SecureVault, 'get'>,
  revocationMarker: Pick<AccountRevocationMarker, 'isRevoked'>,
): Promise<BackgroundSessionInspection> {
  const markerBefore = readAccountRevocationState(revocationMarker);
  if (markerBefore === 'unavailable') return { kind: 'unavailable' };
  if (markerBefore === 'revoked') return { kind: 'revoked' };

  let sessionState: string | null;
  let storedOrigin: string | null;
  let password: string | null;
  let appLockEnabled: string | null;
  try {
    [sessionState, storedOrigin, password, appLockEnabled] = await Promise.all([
      vault.get('serverSessionState'),
      vault.get('serverAddress'),
      vault.get('serverPassword'),
      vault.get('appLockEnabled'),
    ]);
  } catch {
    return { kind: 'unavailable' };
  }

  const markerAfter = readAccountRevocationState(revocationMarker);
  if (markerAfter === 'unavailable') return { kind: 'unavailable' };
  if (markerAfter === 'revoked') return { kind: 'revoked' };

  const hasOrigin = !!storedOrigin;
  const hasPassword = !!password;
  if (sessionState === null && !hasOrigin && !hasPassword) return { kind: 'empty' };

  const activeState = sessionState === null || sessionState === SERVER_SESSION_STATE.active;
  if (
    !activeState ||
    !storedOrigin ||
    !password ||
    (appLockEnabled !== null && appLockEnabled !== 'false' && appLockEnabled !== 'true')
  ) {
    return { kind: 'unsafe' };
  }
  const origin = strictServerOrigin(storedOrigin);
  if (!origin) return { kind: 'unsafe' };
  if (appLockEnabled === 'true') return { kind: 'locked' };
  return { kind: 'ready', session: { origin, password } };
}

function stoppedOutcome(
  baseScope: BackgroundAccountScope,
  marker: Pick<AccountRevocationMarker, 'isRevoked'>,
): BackgroundRunOutcome | null {
  if (!baseScope.isCurrent()) return { result: 'success', reason: 'account-changed' };
  const revocation = readAccountRevocationState(marker);
  if (revocation === 'unavailable') {
    return { result: 'retry', reason: 'durable-state-unavailable' };
  }
  if (revocation === 'revoked') return { result: 'success', reason: 'revoked' };
  return null;
}

function inspectionOutcome(inspection: BackgroundSessionInspection): BackgroundRunOutcome | null {
  switch (inspection.kind) {
    case 'ready':
      return null;
    case 'empty':
      return { result: 'success', reason: 'no-session' };
    case 'locked':
      return { result: 'success', reason: 'app-locked' };
    case 'unsafe':
      return { result: 'success', reason: 'unsafe-session' };
    case 'revoked':
      return { result: 'success', reason: 'revoked' };
    case 'unavailable':
      return { result: 'retry', reason: 'durable-state-unavailable' };
  }
}

/**
 * Deterministic, store-free background bootstrap and work ordering.
 *
 * Only `ready` durable state reaches `createClient`; that client captures one coherent credential
 * pair before the encrypted DB is opened. Sync runs in the sync teardown slot. The schedule and
 * outgoing implementations retain their own realtime-account barriers and receive the same
 * marker-bound scope, so a rapid Disconnect/reconnect cannot turn account-A continuations into
 * account-B work.
 */
export async function runBackgroundSync<Database, Client, ServerInfo>(
  deps: BackgroundSyncDependencies<Database, Client, ServerInfo>,
): Promise<BackgroundRunOutcome> {
  const baseScope = deps.captureAccountScope();
  const scope: BackgroundAccountScope = {
    generation: baseScope.generation,
    isCurrent: () =>
      baseScope.isCurrent() && readAccountRevocationState(deps.revocationMarker) === 'clear',
  };

  const stoppedAtEntry = stoppedOutcome(baseScope, deps.revocationMarker);
  if (stoppedAtEntry) return stoppedAtEntry;

  let context: { db: Database; client: Client; serverInfo: ServerInfo } | undefined;
  let terminalOutcome: BackgroundRunOutcome | undefined;

  try {
    await deps.runTrackedSync(async () => {
      terminalOutcome = stoppedOutcome(baseScope, deps.revocationMarker) ?? undefined;
      if (terminalOutcome) return;

      const inspection = await inspectBackgroundSession(deps.vault, deps.revocationMarker);
      terminalOutcome = inspectionOutcome(inspection) ?? undefined;
      if (terminalOutcome || inspection.kind !== 'ready') return;

      terminalOutcome = stoppedOutcome(baseScope, deps.revocationMarker) ?? undefined;
      if (terminalOutcome) return;

      // No await between the final durable authorization and constructing this immutable session
      // client. Every later request therefore snapshots this one tuple, never a Zustand mirror.
      const client = deps.createClient(inspection.session);
      const db = await deps.openDatabase();
      terminalOutcome = stoppedOutcome(baseScope, deps.revocationMarker) ?? undefined;
      if (terminalOutcome) return;

      // Keep the scope check and request creation in one synchronous turn so HttpClient snapshots
      // the captured account before any response await can cross Disconnect.
      const serverInfoPromise = deps.fetchServerInfo(client);
      const serverInfo = await serverInfoPromise;
      terminalOutcome = stoppedOutcome(baseScope, deps.revocationMarker) ?? undefined;
      if (terminalOutcome) return;

      await deps.synchronize(db, client, deps.serverVersion(serverInfo), scope);
      terminalOutcome = stoppedOutcome(baseScope, deps.revocationMarker) ?? undefined;
      if (terminalOutcome) return;
      context = { db, client, serverInfo };
    });
  } catch (error) {
    const stopped = stoppedOutcome(baseScope, deps.revocationMarker);
    if (stopped) return stopped;
    deps.onWorkError?.(error);
    return { result: 'retry', reason: 'work-failed' };
  }

  if (terminalOutcome) return terminalOutcome;
  if (!context) {
    // Defensive: a compliant runTrackedSync always invokes or rejects its callback.
    return { result: 'retry', reason: 'work-failed' };
  }

  try {
    const stopped = stoppedOutcome(baseScope, deps.revocationMarker);
    if (stopped) return stopped;
    await deps.recoverAndDrainSchedules(context.db, context.client, scope);

    const afterSchedules = stoppedOutcome(baseScope, deps.revocationMarker);
    if (afterSchedules) return afterSchedules;
    await deps.drainOutgoing(context.db, context.client, scope);
  } catch (error) {
    const stopped = stoppedOutcome(baseScope, deps.revocationMarker);
    if (stopped) return stopped;
    deps.onWorkError?.(error);
    return { result: 'retry', reason: 'work-failed' };
  }

  const beforeDiagnostics = stoppedOutcome(baseScope, deps.revocationMarker);
  if (beforeDiagnostics) return beforeDiagnostics;
  if (deps.flushDiagnostics) {
    try {
      await deps.flushDiagnostics(context.db, context.client, context.serverInfo, scope);
    } catch (error) {
      // Diagnostics are deliberately secondary: consent-gated telemetry must never turn a
      // successful message/schedule recovery into WorkManager retry churn.
      deps.onDiagnosticsError?.(error);
    }
  }

  return (
    stoppedOutcome(baseScope, deps.revocationMarker) ?? {
      result: 'success',
      reason: 'completed',
    }
  );
}
