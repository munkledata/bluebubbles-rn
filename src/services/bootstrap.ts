import { serverApi } from '@core/api';
import { isCleartext, sanitizeServerAddress } from '@core/config';
import { logger } from '@core/secure';
import { runDbRekeySelfTest } from '@db/key';
import { checkDeviceIntegrity } from '@native/deviceIntegrity';
import { useLockStore } from '@state/lockStore';
import { useSessionStore } from '@state/sessionStore';
import { candidateClient, http, runCryptoSelfTest, vault } from './clients';
import { initPersistentLogs } from './logging/fileLogSink';
import { applyStoredCertPins } from './certPins';
import { connectToServer } from './connection';
import { ensureDatabase, runSearchTextBackfillOnce } from './databaseControl';
import { hydrateLock } from './lock';
import { getSocket, setSocket, startRealtime } from './realtimeControl';
import { stopReachabilityWatch } from './reachability';
import { startSync } from './syncControl';

/** Load stored credentials from the vault at boot and resolve the initial route. */
export async function hydrateSession(): Promise<void> {
  // Open the encrypted store first so cached data is available offline. A
  // failure must not block reaching the setup UI, but it MUST be visible.
  await ensureDatabase().catch((e: unknown) => {
    logger.error('[db] initialization failed', e);
  });
  // Make older edited/SMS messages searchable (one-time, background — never blocks boot).
  void runSearchTextBackfillOnce();

  const [origin, password] = await Promise.all([
    vault.get('serverAddress'),
    vault.get('serverPassword'),
  ]);
  const store = useSessionStore.getState();
  if (origin && password) {
    store.hydrated({ origin, password });
    // `hydrated` restores creds but NOT serverInfo (only first-setup `connect` sets it), so
    // Settings' Version/macOS/Private-API rows stayed blank on every relaunch. Re-fetch it in
    // the background so those screens populate — best-effort, never blocks boot.
    void serverApi
      .serverInfo(http)
      .then((info) => useSessionStore.getState().setServerInfo(info))
      .catch((e) => logger.debug('[boot] server-info refresh failed', e));
    void startSync();
    void startRealtime();
  } else {
    store.hydrated(null);
  }
}

/**
 * Boot orchestration. Reads the lock setting FIRST (vault-only), then opens the DB
 * + hydrates the session ONLY if not locked. With app-lock on, the SQLCipher key is
 * never released on disk until the user authenticates (see {@link completeUnlock}).
 */
export async function boot(): Promise<void> {
  // Restore last session's app logs into the viewer + start persisting new lines to disk (so the
  // in-app App Logs survive a close/reopen). File-backed, so it's independent of DB/lock state.
  void initPersistentLogs();
  // Pinning must be active BEFORE any network call; the root/jailbreak check is advisory.
  await applyStoredCertPins();
  void checkDeviceIntegrity();
  // DEV: prove the native libsodium AEAD backend works on-device (Phase 0 proof). Gated
  // to dev + fire-and-forget so it never affects a production launch.
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    void runCryptoSelfTest().then((r) => logger.info('[crypto] self-test', r));
    // De-risking spike for key rotation — proves SQLCipher rekey works on a throwaway db.
    void runDbRekeySelfTest().then((r) => logger.info('[db] rekey self-test', r));
  }
  await hydrateLock();
  if (!useLockStore.getState().locked) {
    await hydrateSession();
  }
}

/**
 * Validate + connect to a server, updating the session store with the outcome.
 *
 * `allowCleartext` must be explicitly set true to connect to a plaintext `http://` origin
 * (e.g. a LAN/IP server the user knowingly trusts). By default we reject it: we must never
 * attach the Bearer credential to an unencrypted origin without that acknowledgement. (Android
 * `usesCleartextTraffic=false` also blocks it at the OS layer; this is the clear UX + the
 * credential-safety gate.)
 */
export async function connect(
  rawOrigin: string,
  password: string,
  allowCleartext = false,
): Promise<void> {
  const store = useSessionStore.getState();
  const origin = sanitizeServerAddress(rawOrigin);
  if (!origin) {
    store.failed('Please enter a valid server URL.');
    return;
  }
  if (isCleartext(origin) && !allowCleartext) {
    store.failed(
      'This server uses an insecure http:// connection. Use https://, or enable insecure connections to continue.',
    );
    return;
  }
  if (!password) {
    store.failed('Please enter your server password.');
    return;
  }

  store.beginConnecting();
  const client = candidateClient(origin, password);
  const result = await connectToServer(origin, password, {
    fetchServerInfo: () => serverApi.serverInfo(client),
    vault,
  });

  if (result.ok) {
    store.connected(origin, password, result.serverInfo);
    void startSync();
    void startRealtime();
  } else {
    store.failed(result.message);
  }
}

/** Forget the connection: clear credentials and reset the session. */
export async function forget(): Promise<void> {
  stopReachabilityWatch();
  getSocket()?.disconnect();
  setSocket(null);
  await Promise.all([vault.delete('serverAddress'), vault.delete('serverPassword')]);
  useSessionStore.getState().reset();
}
