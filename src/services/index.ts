import { chatsApi, HttpClient, serverApi } from '@core/api';
import { isCleartext, sanitizeServerAddress } from '@core/config';
import { SecretBox } from '@core/crypto';
import { logger } from '@core/secure';
import { applyCertPinning, type CertPins } from '@native/certPinning';
import { checkDeviceIntegrity } from '@native/deviceIntegrity';
import { getDatabase, getRawDatabase, initDatabase } from '@db/database';
import { resolveDbKey, rotateDbKey, runDbRekeySelfTest } from '@db/key';
import {
  getChatIdByGuid,
  getNewestReceivedGuid,
  getSyncMarker,
  setLastReadMessageGuid,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { ExpoSecureVault } from '@native/secureVault';
import { useLockStore } from '@state/lockStore';
import { sessionAccessors, useSessionStore } from '@state/sessionStore';
import { useSyncStore } from '@state/syncStore';
import { useTypingStore } from '@state/typingStore';
import { DevPushTransport, type EventSink, EventRouter, FCM_ENABLED } from '@core/realtime';
import { connectToServer } from './connection';
import { useRedactedModeStore } from '@state/redactedModeStore';
import { buildMessageIntents } from './notifications/intents';
import {
  postNotification,
  requestNotificationPermission,
  setHideNotificationPreview,
} from './notifications/notifeeService';
import { DbEventSink } from './realtime/dbEventSink';
import { NotifyingEventSink } from './realtime/notifyingEventSink';
import { TypingEventSink } from './realtime/typingEventSink';
import { SocketService } from './realtime/socketService';
import { fullSync, httpSyncApi, incrementalSync, syncAllChats, syncChatMessages } from './sync';
import { syncContacts } from './contacts/contactsService';

/**
 * Composition root.
 *
 * Instantiates the app's services once and wires them together explicitly
 * (replacing GetX's global service locator). The store-bound HttpClient reads
 * the active origin/password synchronously from the session store, so its auth
 * header is always current — and never appears in a URL.
 */

export const vault = new ExpoSecureVault();

/** The primary client, bound to the connected session. */
export const http = new HttpClient({
  getOrigin: sessionAccessors.getOrigin,
  getPassword: sessionAccessors.getPassword,
});

/** A throwaway client for validating candidate credentials during setup. */
function candidateClient(origin: string, password: string): HttpClient {
  return new HttpClient({ getOrigin: () => origin, getPassword: () => password });
}

let socket: SocketService | null = null;

// ── Authenticated encryption (XChaCha20-Poly1305 + Argon2id) ───────────────────
// The native libsodium backend is pulled in via a dynamic import so it is evaluated
// only on first crypto use — never at startup — keeping a JS bundle safe on a build
// that hasn't yet linked the native module (the lazy native-module import pattern).
let secretBoxPromise: Promise<SecretBox> | null = null;

/**
 * The app's authenticated-encryption box, backed by native libsodium. Lazily
 * constructed once. Use for at-rest secret wrapping / server payloads (see SecretBox).
 * Requires a native build that links `react-native-libsodium` (Phase 0 rebuild).
 */
export function getSecretBox(): Promise<SecretBox> {
  secretBoxPromise ??= (async (): Promise<SecretBox> => {
    const { createNativeCryptoBackend } = await import('@native/crypto');
    return new SecretBox(await createNativeCryptoBackend());
  })();
  return secretBoxPromise;
}

/**
 * Dev-only crypto round-trip self-test (Phase 0 device proof). Seals then opens a
 * known string and asserts equality — exercises the real native AEAD + KDF on device.
 * NOT run at startup (it would load the native module); invoke it manually after the
 * libsodium-linked rebuild, e.g. from a dev button.
 */
export async function runCryptoSelfTest(): Promise<{ ok: boolean; detail: string }> {
  try {
    const box = await getSecretBox();
    const secret = 'bluebubbles-crypto-self-test-✅';
    const sealed = await box.seal(secret, 'correct horse battery staple');
    const opened = await box.open(sealed, 'correct horse battery staple');
    let tamperRejected = false;
    try {
      await box.open(sealed, 'wrong passphrase');
    } catch {
      tamperRejected = true; // authenticated decryption must reject a bad key
    }
    const ok = opened === secret && tamperRejected;
    return { ok, detail: ok ? 'round-trip + tamper-reject OK' : 'mismatch or tamper not rejected' };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : 'self-test threw' };
  }
}

/** Open the encrypted DB (once), generating the SQLCipher key on first run. */
export async function ensureDatabase(): Promise<AppDatabase> {
  // resolveDbKey (not getOrCreateDbKey) so a key rotation interrupted by a crash is
  // finished here before the DB is opened.
  const key = await resolveDbKey(vault);
  return initDatabase(key);
}

/** Rotate the SQLCipher database key (crash-safe). The open connection keeps working. */
export async function rotateDatabaseKey(): Promise<void> {
  await rotateDbKey(vault, getRawDatabase());
}

/**
 * Create a new chat with the given recipient addresses + an initial message, upsert the
 * returned chat locally so it appears immediately, and return its guid (route into it).
 */
export async function createNewChat(
  addresses: string[],
  message: string,
  service = 'iMessage',
): Promise<string> {
  const db = await ensureDatabase();
  const chat = await chatsApi.createChat(http, { addresses, message, service });
  const handleIds = await upsertHandles(db, chat.participants ?? []);
  await upsertChats(db, [chat], handleIds);
  return chat.guid;
}

// One realtime sink, shared by the socket and the dev/FCM transports so behavior is
// identical regardless of how the event arrived. Outer layer routes ephemeral typing
// events to UI state; inner layer writes the DB (source of truth) then notifies.
let realtimeSinkInstance: EventSink | null = null;
function realtimeSink(db: AppDatabase): EventSink {
  realtimeSinkInstance ??= new TypingEventSink(
    new NotifyingEventSink(
      new DbEventSink(db),
      db,
      buildMessageIntents,
      (intent) => void postNotification(intent),
    ),
    (chatGuid, display) => useTypingStore.getState().setTyping(chatGuid, display),
  );
  return realtimeSinkInstance;
}

// ONE EventRouter shared across every transport (socket, dev injection, FCM) so its dedup
// `seen` set spans them — a message delivered by BOTH socket and FCM is then processed (and
// notified) exactly once (separate routers = separate sets = the dedup is a no-op). The socket
// is handed this same instance in startRealtime().
let sharedRouterInstance: EventRouter | null = null;
function sharedRouter(db: AppDatabase): EventRouter {
  sharedRouterInstance ??= new EventRouter(realtimeSink(db));
  return sharedRouterInstance;
}

/** Dispatch a raw realtime event through the shared pipeline (dev injection / FCM). */
export async function dispatchRealtimeEvent(eventName: string, rawData: unknown): Promise<void> {
  const db = await ensureDatabase();
  // A killed-app FCM wake does NOT run the UI boot effect that seeds the notification
  // hide-preview flag, so sync it from the persisted setting before we notify —
  // otherwise a headless push would leak message content despite redacted mode being ON.
  await useRedactedModeStore.getState().hydrate();
  setHideNotificationPreview(useRedactedModeStore.getState().enabled);
  await sharedRouter(db).handle(eventName, rawData, 'fcm');
}

/** Dev push transport, pre-bound to dispatch — drives the "Inject message" button. */
export const devPush = new DevPushTransport();
devPush.start(dispatchRealtimeEvent);

/** Load stored credentials from the vault at boot and resolve the initial route. */
export async function hydrateSession(): Promise<void> {
  // Open the encrypted store first so cached data is available offline. A
  // failure must not block reaching the setup UI, but it MUST be visible.
  await ensureDatabase().catch((e: unknown) => {
    logger.error('[db] initialization failed', e);
  });

  const [origin, password] = await Promise.all([
    vault.get('serverAddress'),
    vault.get('serverPassword'),
  ]);
  const store = useSessionStore.getState();
  if (origin && password) {
    store.hydrated({ origin, password });
    void startSync();
    void startRealtime();
  } else {
    store.hydrated(null);
  }
}

// ── App lock ───────────────────────────────────────────────────────────────────
// The lock setting lives in the vault (NOT the encrypted DB) so it's readable at
// cold boot before the DB key is released. When lock is on, `boot()` withholds the
// SQLCipher key until `completeUnlock()` runs after a successful biometric auth.

/** Read the persisted app-lock setting from the vault (no DB needed) and apply it. */
export async function hydrateLock(): Promise<void> {
  const v = await vault.get('appLockEnabled');
  useLockStore.getState().hydrate(v === 'true');
}

/** Persist the app-lock setting. Callers must confirm biometrics exist before enabling. */
export async function setAppLockEnabled(enabled: boolean): Promise<void> {
  await vault.set('appLockEnabled', enabled ? 'true' : 'false');
  useLockStore.getState().setEnabled(enabled);
}

/**
 * Boot orchestration. Reads the lock setting FIRST (vault-only), then opens the DB
 * + hydrates the session ONLY if not locked. With app-lock on, the SQLCipher key is
 * never released on disk until the user authenticates (see {@link completeUnlock}).
 */
export async function boot(): Promise<void> {
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

/** After a successful unlock: open the DB + route if the cold boot deferred it, then clear the gate. */
export async function completeUnlock(): Promise<void> {
  if (useSessionStore.getState().status === 'loading') {
    await hydrateSession();
  }
  useLockStore.getState().unlock();
}

// ── TLS certificate pinning ──────────────────────────────────────────────────
// Pins live in the vault (host → SPKI hashes) so they apply before any network call.
// Empty by default (no-op); populate via setCertPins once you have the server's hash.

/** Read the stored TLS pins (host → base64 SHA-256 SPKI hashes). */
export async function getCertPins(): Promise<CertPins> {
  const raw = await vault.get('certPins');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as CertPins;
  } catch {
    return {};
  }
}

/** Persist + immediately apply TLS pins. Pass `{}` to clear (then a rebuild to drop native pinning). */
export async function setCertPins(pins: CertPins): Promise<void> {
  await vault.set('certPins', JSON.stringify(pins));
  await applyCertPinning(pins);
}

/** Apply the stored pins (called at boot). No-op when none are configured. */
export async function applyStoredCertPins(): Promise<void> {
  await applyCertPinning(await getCertPins());
}

/** Run a full sync on first connect, otherwise an incremental catch-up sync. */
export async function startSync(): Promise<void> {
  const sync = useSyncStore.getState();
  try {
    const db = await ensureDatabase();
    const api = httpSyncApi(http);
    sync.begin();

    const marker = await getSyncMarker(db);
    const isFirstSync = marker.lastSyncedRowId == null && marker.lastSyncedTimestamp == null;
    if (isFirstSync) {
      const result = await fullSync(db, api, { onProgress: (p) => sync.progress(p) });
      sync.done(result);
    } else {
      // Refresh the FULL chat list first so conversations the interrupted first sync never reached
      // (disproportionately older SMS threads) appear in the inbox; their history backfills on open.
      // Best-effort — a failure here must not block the incremental message sync below.
      await syncAllChats(db, api).catch((e) => logger.debug('[sync] chat-list refresh failed', e));
      const version =
        useSessionStore.getState().serverInfo?.server_version ?? (await api.serverVersion());
      // Per-page progress so the DB-reactive inbox hydrates mid-sync (not just at the end).
      const result = await incrementalSync(db, api, {
        serverVersion: version,
        onProgress: (p) => sync.progress(p),
      });
      sync.done(result);
    }
  } catch (e) {
    sync.fail(e instanceof Error ? e.message : 'Sync failed');
  }

  // Resolve device contacts onto handles so chats — especially GROUPS — show contact names
  // instead of raw phone numbers in the inbox/headers. Fire-and-forget with its own catch:
  // a denied contacts permission (or any IO error) must NOT affect the message-sync status.
  // Runs after connect and on every boot-with-session (both call startSync); idempotent.
  void syncContacts().catch((e) => logger.debug('[contacts] auto-sync skipped', e));
}

/**
 * Backfill ONE chat's message history from the server, on demand (called when a thread opens).
 * Makes a thread show its full history even if the large initial sync hasn't reached it yet or
 * was interrupted — independent of the global sync marker. Best-effort; never throws to the UI.
 */
export async function ensureChatSynced(chatGuid: string): Promise<number> {
  try {
    const db = await ensureDatabase();
    return await syncChatMessages(db, httpSyncApi(http), chatGuid, { maxMessages: 500 });
  } catch (e) {
    logger.warn('[sync] on-demand chat backfill failed', e);
    return 0;
  }
}

/** Connect the live socket and route its events into the DB. */
export async function startRealtime(): Promise<void> {
  const db = await ensureDatabase();
  const { origin, password } = useSessionStore.getState();
  if (!origin || !password) return;
  socket?.disconnect();
  // Hand the socket the SHARED router so socket + FCM dedup against one `seen` set (F-31).
  socket = new SocketService(realtimeSink(db), sharedRouter(db));
  // Keep the socket in the SAME auth mode as REST: header/auth-payload by default,
  // `?guid=` query against a stock server that only reads the legacy param.
  socket.connect(origin, password, {
    headers: http.buildHeaders(),
    legacyQueryAuth: !http.usesHeaderAuth(),
  });
  void requestNotificationPermission();
  // Now that we're connected, register this device's FCM token with the server so it
  // can push to us. Firebase is dynamically imported to keep it out of the test/static
  // graph (and a no-op until FCM is enabled).
  if (FCM_ENABLED) {
    void import('./notifications/fcmMessaging').then((m) => m.registerFcmToken());
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

/**
 * Emit a typing indicator to the server. The server listens on `start-typing` / `stop-typing`
 * with a `{ guid }` payload — NOT `started-typing`/`stopped-typing` with `{ chatGuid }` (which
 * it ignored, so the indicator never reached the other party). No-op when not connected.
 * SERVER-GATED: the server only relays this with the **private API** enabled, so it can't be
 * verified without a server.
 */
export function sendTyping(chatGuid: string, isTyping: boolean): void {
  socket?.emit(isTyping ? 'start-typing' : 'stop-typing', { guid: chatGuid });
}

/** Mark a chat read: update the local read marker (clears the badge) and notify the server. */
export async function markRead(chatGuid: string): Promise<void> {
  const db = getDatabase();
  const chatId = await getChatIdByGuid(db, chatGuid);
  if (chatId == null) return;
  const newest = await getNewestReceivedGuid(db, chatId);
  if (newest) await setLastReadMessageGuid(db, chatGuid, newest);
  try {
    await chatsApi.markChatRead(http, chatGuid);
  } catch {
    // Offline / not connected — the local marker still clears the badge.
  }
}

/** Forget the connection: clear credentials and reset the session. */
export async function forget(): Promise<void> {
  socket?.disconnect();
  socket = null;
  await Promise.all([vault.delete('serverAddress'), vault.delete('serverPassword')]);
  useSessionStore.getState().reset();
}
