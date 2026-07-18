import { serverApi } from '@core/api';
import { logger } from '@core/secure';
import { DevPushTransport, type EventSink, EventRouter, FCM_ENABLED } from '@core/realtime';
import { chatHasKnownSender } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { useFaceTimeStore } from '@state/faceTimeStore';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useRcsHealthStore } from '@state/rcsHealthStore';
import { useRedactedModeStore } from '@state/redactedModeStore';
import { useSessionStore } from '@state/sessionStore';
import { useTypingStore } from '@state/typingStore';
import { http, vault } from './clients';
import { ensureSyncedBackground } from './backgrounds/syncedBackground';
import { ensureDatabase } from './databaseControl';
import { maybeResumeSync } from './syncControl';
import { autoDownloadMessageAttachments } from './download/autoDownloadAttachments';
import { startReachabilityWatch } from './reachability';
import { buildMessageIntents } from './notifications/intents';
import {
  postNotification,
  requestNotificationPermission,
  setHideNotificationPreview,
} from './notifications/notifeeService';
import { DbEventSink } from './realtime/dbEventSink';
import { GroupEventSideEffectSink } from './realtime/groupEventSideEffectSink';
import { NotifyingEventSink } from './realtime/notifyingEventSink';
import { TypingEventSink } from './realtime/typingEventSink';
import { FaceTimeEventSink } from './realtime/faceTimeEventSink';
import { ServerUrlEventSink } from './realtime/serverUrlEventSink';
import { RcsAlertEventSink } from './realtime/rcsAlertEventSink';
import { createServerUrlResolver } from './realtime/serverUrlResolver';
import { SocketService } from './realtime/socketService';

let socket: SocketService | null = null;
// Guards the ONE-TIME realtime setup (notification/FCM permission + token registration) so it
// runs on the FIRST connect only — never on a foreground reconnect. See startRealtime().
let realtimeOneTimeSetupDone = false;

/** Read the live socket (or null). Used by callers outside this module (e.g. sendTyping). */
export function getSocket(): SocketService | null {
  return socket;
}

/** Replace the live socket reference (or clear it). Used by teardown callers (e.g. forget). */
export function setSocket(next: SocketService | null): void {
  socket = next;
}

// One realtime sink, shared by the socket and the dev/FCM transports so behavior is
// identical regardless of how the event arrived. Outer layer routes ephemeral typing
// events to UI state; inner layer writes the DB (source of truth) then notifies.
let realtimeSinkInstance: EventSink | null = null;
function realtimeSink(db: AppDatabase): EventSink {
  realtimeSinkInstance ??= new ServerUrlEventSink(
    new RcsAlertEventSink(
      new FaceTimeEventSink(
        new TypingEventSink(
          new GroupEventSideEffectSink(
            new NotifyingEventSink(
              new DbEventSink(
                db,
                (messageId) => void autoDownloadMessageAttachments(db, messageId),
              ),
              db,
              buildMessageIntents,
              (intent) => {
                // Honor the global "Message Notifications" toggle (message-kind only; calls/reminders
                // still post). Gated here (not in the pure buildMessageIntents) so the Node tests don't
                // pull the kv-backed store — and the DB is still written regardless.
                if (
                  intent.kind === 'message' &&
                  !useFeatureSettingsStore.getState().messageNotifications
                ) {
                  return;
                }
                // "Filter Unknown Senders": a chat with no contact-matched participant notifies
                // silently (DB/badge only) when the filter is on — parity with the old app's muted
                // unknown-sender notifications. Same gating layer as the toggle above.
                if (
                  intent.kind === 'message' &&
                  useFeatureSettingsStore.getState().filterUnknownSenders
                ) {
                  // Fail OPEN: if the known-sender lookup rejects (a DB read hiccup), still post the
                  // notification rather than silently swallowing it as an unhandled rejection — a
                  // dropped alert is worse than an occasional unfiltered one. The DB row is already
                  // written regardless (this gate only decides whether to raise the notification).
                  void chatHasKnownSender(db, intent.chatGuid)
                    .then((known) => {
                      if (known) void postNotification(intent);
                    })
                    .catch((e) => {
                      logger.warn('[notify] known-sender check failed — notifying anyway', e);
                      void postNotification(intent);
                    });
                  return;
                }
                void postNotification(intent);
              },
            ),
            // Chat-background changed/removed group event → refetch the synced wallpaper. Injected
            // (not run inside DbEventSink) because it's a network + DB side effect. Change-detects
            // internally, so calling it on ingestion — before the channel visibly syncs — is safe.
            (guid) => ensureSyncedBackground(http, db, guid),
          ),
          (chatGuid, display) => useTypingStore.getState().setTyping(chatGuid, display),
        ),
        (c) => useFaceTimeStore.getState().ring(c),
        (uuid) => useFaceTimeStore.getState().dismissIncoming(uuid),
      ),
      (alertType) => useRcsHealthStore.getState().setAlert(alertType),
    ),
    (url) => void applyNewServerUrl(url),
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
  // A killed-app FCM wake does NOT run the UI boot effect that seeds the notification hide-preview
  // flag / feature flags, so hydrate them from the persisted settings before we notify — otherwise
  // a headless push would leak content despite redacted mode being ON, or ignore the "Message
  // Notifications" toggle. Gate on each store's `hydrated` flag so this hits the DB only ONCE per
  // JS context (the first event of a wake), not on every event: the in-memory store is already
  // authoritative after the first hydrate, and its setters keep it current, so re-reading kv on
  // every push (including the frequent silent updated-message receipts) was pure redundant work.
  const redacted = useRedactedModeStore.getState();
  if (!redacted.hydrated) await redacted.hydrate();
  setHideNotificationPreview(useRedactedModeStore.getState().enabled);
  const features = useFeatureSettingsStore.getState();
  if (!features.hydrated) await features.hydrate();
  await sharedRouter(db).handle(eventName, rawData, 'fcm');
}

/** Dev push transport, pre-bound to dispatch — drives the "Inject message" button. */
export const devPush = new DevPushTransport();
devPush.start(dispatchRealtimeEvent);

// Reconnect-escalation URL rediscovery: when the socket's capped retries are exhausted, ask
// whether the server URL rotated while the socket was down. Today the one source is the session
// store — `applyNewServerUrl` (a `new-server` event, possibly delivered over FCM while the socket
// was dead) has already persisted the rotated origin there; a future Firebase-RTDB lookup can be
// appended as another source without touching the socket.
const refreshServerUrl = createServerUrlResolver([
  { name: 'session', get: () => useSessionStore.getState().origin },
]);

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
    refreshUrl: refreshServerUrl,
  });
  // Auto-resume HTTP sync when the server becomes reachable again after a drop. The socket's own
  // reconnect covers the happy path, but for users who lose connectivity often (and whose websocket
  // frequently can't re-establish) this lightweight ping-on-a-timer is what actually brings sync
  // back without a manual pull. `ping` is non-retrying, so it detects "down" fast.
  startReachabilityWatch(() => serverApi.ping(http), maybeResumeSync);
  // ONE-TIME: requesting notification permission (notifee + FCM) launches the system permission
  // dialog, and that dialog itself fires an AppState change → the foreground `resumeRealtime()`
  // listener → `startRealtime()` again. Doing it on EVERY (re)connect created an INFINITE
  // permission-request loop the first time the app foregrounded (the UI froze; logcat showed
  // GrantPermissionsActivity launched tens of thousands of times). Request it once.
  if (!realtimeOneTimeSetupDone) {
    realtimeOneTimeSetupDone = true;
    void requestNotificationPermission();
  }
  // Register this device's FCM token on EVERY (re)connect — NOT once. The server de-dupes by token
  // (register-device collapses duplicate rows), so this is idempotent and cheap, and it is the only
  // thing that keeps push alive across the cases a one-shot registration silently broke: a transient
  // failure at first boot (server briefly unreachable → no token → zero pushes all session), a
  // reconnect to a DIFFERENT server after `forget()` (new server never learned the token), and an
  // FCM token rotation that landed while disconnected. Firebase is dynamically imported to keep it
  // out of the test/static graph (a no-op until FCM is enabled).
  if (FCM_ENABLED) {
    void import('./notifications/fcmMessaging').then((m) => m.registerFcmToken());
  }
}

/**
 * Foreground/background lifecycle for the live socket.
 *
 * Android freezes the JS thread + the socket while the app is backgrounded, so on resume the
 * socket can be silently stale — the `updated-message` (Delivered) and `new-message` events then
 * limp in over slow FCM instead of the fast socket. Tearing the socket down on background makes
 * the resume a deterministic fresh reconnect (rather than waiting for socket.io to notice the dead
 * connection via a late ping-timeout). Wired to AppState in `app/(app)/_layout.tsx`.
 */
export function pauseRealtime(): void {
  socket?.disconnect();
  socket = null;
}

/**
 * On foreground: reconnect the socket if it isn't currently connected, and ALWAYS pull anything
 * missed while backgrounded over HTTP (fast + deterministic) instead of waiting on the socket
 * handshake or FCM. `maybeResumeSync` is coalesced/throttled, so a quick app-switch is cheap.
 */
export async function resumeRealtime(): Promise<void> {
  const { origin, password } = useSessionStore.getState();
  if (!origin || !password) return;
  if (!socket || !socket.connected) await startRealtime();
  maybeResumeSync();
}

/**
 * Apply the server's `new-server` event: its public URL rotated (e.g. the zrok tunnel), so
 * re-point the session + persisted credential at the new origin and reconnect — otherwise the app
 * keeps hitting the stale URL until a manual reconnect. Scheme-validated (never point auth at a
 * non-http(s) origin). The HttpClient reads the origin from the session accessors, so updating the
 * store re-points REST too; `startRealtime` rebuilds the socket against the new origin.
 */
export async function applyNewServerUrl(url: string): Promise<void> {
  const next = url.trim();
  if (!/^https?:\/\//i.test(next)) {
    logger.warn('[realtime] ignoring new-server URL with a non-http(s) scheme');
    return;
  }
  if (useSessionStore.getState().origin === next) return; // unchanged
  logger.info('[realtime] server URL rotated — reconnecting to the new origin');
  try {
    await vault.set('serverAddress', next);
  } catch {
    // best-effort persist; the in-memory origin still applies this session
  }
  useSessionStore.getState().setOrigin(next);
  await startRealtime();
}
