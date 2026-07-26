import { serverApi } from '@core/api';
import { isCleartext, sanitizeServerAddress } from '@core/config';
import { logger } from '@core/secure';
import { runDbRekeySelfTest } from '@db/key';
import { clearLocalCache, listReminders, localCacheDirty } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { checkDeviceIntegrity } from '@native/deviceIntegrity';
import { hydrateAllStores } from '@state/hydrateStores';
import { useLockStore } from '@state/lockStore';
import { useSessionStore } from '@state/sessionStore';
import { candidateClient, http, runCryptoSelfTest, vault } from './clients';
import { initErrorReporting } from './errors';
import { initPersistentLogs } from './logging/fileLogSink';
import { applyStoredCertPins } from './certPins';
import { connectToServer } from './connection';
import { ensureDatabase, runSearchTextBackfillOnce } from './databaseControl';
import { hydrateLock } from './lock';
import { getSocket, setSocket, startRealtime } from './realtimeControl';
import { stopReachabilityWatch } from './reachability';
import { awaitSyncIdle, startSync } from './syncControl';

/** Load stored credentials from the vault at boot and resolve the initial route. */
export async function hydrateSession(): Promise<void> {
  // Open the encrypted store first so cached data is available offline. A
  // failure must not block reaching the setup UI, but it MUST be visible.
  await ensureDatabase().catch((e: unknown) => {
    logger.error('[db] initialization failed', e);
  });
  // FIRST point the kv store is readable: every store's `hydrate()` calls `getDatabase()`, which
  // THROWS until the DB is open, so the root layout's pre-boot pass always no-ops on a cold launch
  // and the settings stay at their module defaults until the home screen's re-hydrate. Awaited
  // HERE because `runSync` reads `messagesPerChat` and `void startSync()` is fired below — without
  // this, a user who chose 25/chat silently got the default 100 on the first sync after every
  // relaunch. This does NOT hold ThemeProvider's anti-flash gate: `themeStore.hydrate()` sets
  // `hydrated: true` from its own catch (the deliberate never-hang fallback), so the gate has
  // already opened on the DEFAULT preset by the time we reach this line — all we do for the theme
  // is shorten how long the wrong colours are on screen. Idempotent, and the per-store try/catch
  // means a failure here can never block boot.
  await hydrateAllStores();
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
  // Capture app errors (uncaught JS + unhandled rejections + every `error`-level log) into the
  // durable upload queue, and install the global handlers. Independent of DB/lock state — the
  // capture sink buffers in memory until the DB opens. Uploads happen later, once connected.
  initErrorReporting();
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

  // A Disconnect navigates away the moment the session resets, but its wipe keeps running behind
  // the setup screen (it may be waiting out a dying sync). Connecting on top of that would race
  // `clearLocalCache` into the NEW server's freshly synced rows — deleting them and, worse, letting
  // the new sync write a marker over the wipe's reset, which sends the next run down the
  // incremental branch with holes behind it. Wait it out; it is idle in every normal case.
  await awaitForgetIdle();

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

/**
 * Forget the connection: clear the credentials, reset the session, and destroy everything this
 * device holds for that server — cached rows (`clearLocalCache`), the reminders' OS alarms, the
 * Direct Share chips, and the downloaded media on disk. The order matters and is explained inline.
 * Every step past the credential clear is best-effort: a Disconnect must complete even if the DB
 * or the filesystem is unavailable.
 *
 * Exported through the {@link forget} wrapper, which publishes the run so `connect()` can wait for
 * it — the session reset happens early, so the user is already back on the setup screen while this
 * is still deleting.
 */
async function runForget(): Promise<void> {
  stopReachabilityWatch();
  getSocket()?.disconnect();
  setSocket(null);
  // Close the authorization window BEFORE the wipe, not after. A sync started at boot can still be
  // paging when the user taps Disconnect, and nothing cancels it — with the credentials still in
  // place its remaining requests stay fully authorized, so `upsertChats`/`upsertMessages` land
  // AFTER the deletes and `fullSync` then writes a non-null marker. Clearing the origin first makes
  // every in-flight request fail immediately (a reset origin builds a relative URL), so the run
  // unwinds in seconds instead of minutes, and it means a Disconnect is honoured even if
  // everything below throws.
  //
  // allSettled, not all: on Android these are Keystore-backed writes, and a rejection from either
  // one used to abort the whole Disconnect — the session was never reset (the app still believed
  // it was connected, with its socket already gone), nothing was wiped, and the previous account's
  // threads, media and Direct Share chips stayed on the device while the confirmation dialog had
  // just promised the opposite. The user could not even retry, because the next launch sees one
  // credential missing and routes to setup. Both outcomes are logged, and the in-memory reset
  // happens regardless: it closes the authorization window even when the on-disk delete did not.
  const cleared = await Promise.allSettled([
    vault.delete('serverAddress'),
    vault.delete('serverPassword'),
  ]);
  for (const outcome of cleared) {
    if (outcome.status === 'rejected') {
      logger.warn('[forget] credential delete failed — it is still in the vault', outcome.reason);
    }
  }
  useSessionStore.getState().reset();
  // …then let that dying run actually finish before we delete anything. Bounded: if a request is
  // wedged we still owe the user the wipe, and by now it can't fetch anything new anyway.
  await withDeadline(awaitSyncIdle(), SYNC_DRAIN_DEADLINE_MS);

  // Wipe everything the DB cached FROM this server. Clearing the credentials alone leaves the
  // whole local store intact, so connecting to a DIFFERENT server next shows the previous
  // account's threads interleaved with the new ones — on a shared device, someone else's
  // conversations — and the surviving sync marker sends the next sync down the incremental
  // branch with the OLD server's ROWID cursor. Unconditional: `applyNewServerUrl` legitimately
  // rewrites the origin for the SAME server on a tunnel rotation, so "did the origin change?"
  // is not a usable test. Best-effort — a wipe failure must never make logout fail.
  try {
    const db = await ensureDatabase();
    // Cancel the reminders' OS alarms BEFORE their rows go: a trigger notification is system
    // state that outlives the row, so an uncancelled one still fires later and deep-links into a
    // chat that no longer exists. Its OWN try/catch — the lazy import pulls notify-kit's native
    // bridge (kept out of this module's load graph on purpose), and failing to reach it must not
    // cost us the wipe below.
    try {
      const pending = await listReminders(db);
      if (pending.length > 0) {
        const { cancelReminderNotification } = await import('./notifications/notifeeService');
        await Promise.all(
          pending.map((r) =>
            cancelReminderNotification(r.notificationId).catch(() => {
              // an already-fired / unknown trigger id is fine to skip
            }),
          ),
        );
      }
    } catch (e) {
      logger.warn('[forget] reminder cancel failed', e);
    }
    await wipeLocalCache(db);
  } catch (e) {
    // warn, not error: this runs while disconnecting, and an `error` line would be queued for
    // upload to the very server we are leaving.
    logger.warn('[forget] local cache wipe could not run', e);
  }
  await deleteCachedMedia();
  // Drop the Direct Share targets LAST. They point at this account's chats, and dynamic shortcuts are
  // persistent SYSTEM state that outlives the process — so clearing them early is worse than useless:
  // the trailing fire-and-forget contacts sync (and anything else still unwinding above) republishes
  // them from rows that were still present at the time, leaving the previous account's names and
  // photos in the share sheet of whoever uses the device next. Everything that could republish is
  // finished by here. Lazy import keeps this module's React-free, node-tested graph off the native
  // bridge at load; best-effort, because a logout must not fail on a shortcut cleanup.
  try {
    const { clearShareShortcuts } = await import('./shortcuts/shareShortcuts');
    clearShareShortcuts();
  } catch (e) {
    logger.warn('[forget] could not clear Direct Share shortcuts', e);
  }
}

/** How many times `forget()` will run the wipe before giving up (see {@link wipeLocalCache}). */
const WIPE_ATTEMPTS = 2;

/**
 * Run the local wipe and CONFIRM it, re-running once if rows survived.
 *
 * `clearLocalCache` is a dozen independent statements — it cannot be one transaction without
 * holding the process-wide write lock for the seconds it takes to delete every message on the
 * device (see its own note). So a partial wipe is reachable and, worse, SILENT: a statement swept
 * into a neighbouring writer's rolled-back transaction throws nothing, and an FK error from a
 * concurrent sync slice re-inserting messages is caught by the caller and logged at `warn`. Either
 * way the previous account's conversations are still on the device — the exact leak Disconnect
 * exists to close, and one the user is told has happened.
 *
 * A second pass fixes both: whatever raced the first one has stopped by then (the credentials are
 * long gone), and the wipe is idempotent. Anything still dirty after that is logged rather than
 * hidden — Disconnect must still complete, since the credentials are already destroyed.
 */
async function wipeLocalCache(db: AppDatabase): Promise<void> {
  for (let attempt = 1; attempt <= WIPE_ATTEMPTS; attempt++) {
    try {
      await clearLocalCache(db);
    } catch (e) {
      logger.warn(`[forget] local cache wipe attempt ${attempt} failed`, e);
    }
    if (!(await localCacheDirty(db))) return;
    logger.warn(`[forget] local cache still populated after wipe attempt ${attempt}`);
  }
}

/** The wipe currently running, as a promise that never rejects (see {@link forget}). */
let forgetInFlight: Promise<void> | null = null;

/**
 * Forget the connection (see {@link runForget}), publishing the run so `connect()` can wait it out.
 *
 * The tracked promise is a NON-REJECTING view of the run: waiters only need to know the wipe has
 * stopped, and parking a rejecting promise in a module slot that nobody awaits would surface as an
 * unhandled rejection. The caller still receives the real promise, with the real error.
 */
export function forget(): Promise<void> {
  const run = runForget();
  const settled = run
    .catch(() => undefined)
    .finally(() => {
      if (forgetInFlight === settled) forgetInFlight = null;
    });
  forgetInFlight = settled;
  return run;
}

/** Resolve once no `forget()` wipe is running — immediately when none is. Never rejects. */
async function awaitForgetIdle(): Promise<void> {
  await forgetInFlight;
}

/**
 * Directories under the app's DOCUMENTS dir that mirror server content (or are pinned to a chat
 * guid). `clearLocalCache` deletes the rows that hold their paths, so every byte left here is
 * unreachable by any code path — on an auto-download account that is gigabytes of photos only
 * "Clear app data" could ever reclaim, and the Disconnect confirmation promises they go.
 *
 * Deliberately NOT listed: `app-logs.json` (diagnostics the user may still want to send) and
 * anything under `Paths.cache` (the OS reclaims it, and backup/share staging delete their own).
 */
const WIPED_MEDIA_DIRS = [
  'attachments', // downloadService → expoFetcher
  'server-contact-avatars', // backfillServerAvatars
  'synced-backgrounds', // syncedBackground
  'chat-bg', // the user's own per-chat wallpaper picks — their chat rows go with the wipe
] as const;

/**
 * Best-effort removal of the on-disk media the wipe just orphaned. Its own function (and its own
 * try/catch per directory) because expo-file-system is a native module: the lazy import keeps it
 * out of this module's node-test load graph, and a filesystem failure must never make logout fail
 * or cost us the DB wipe that already happened.
 */
async function deleteCachedMedia(): Promise<void> {
  try {
    const { Directory, Paths } = await import('expo-file-system');
    for (const name of WIPED_MEDIA_DIRS) {
      try {
        const dir = new Directory(Paths.document, name);
        if (dir.exists) dir.delete();
      } catch (e) {
        logger.warn(`[forget] could not delete cached media dir ${name}`, e);
      }
    }
  } catch (e) {
    logger.warn('[forget] filesystem unavailable — cached media left on disk', e);
  }
}

/** How long `forget()` waits for a dying sync before wiping anyway (see the call site). */
const SYNC_DRAIN_DEADLINE_MS = 20_000;

/** Await `p`, but give up after `ms` — the caller must make progress either way. */
async function withDeadline(p: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      p,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
