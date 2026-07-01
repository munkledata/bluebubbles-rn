/**
 * App-wide constants for the React-free core layer.
 */

/** REST API base path appended to the server origin. */
export const API_BASE_PATH = '/api/v1';

/**
 * Minimum BlueBubbles Server version required by this client.
 *
 * The rebuild moves the auth token out of the URL query string and into an
 * `Authorization` header / socket `auth` payload, and adopts AEAD payload
 * crypto. Both require server support, so setup gates on this version.
 */
export const MIN_SERVER_VERSION = '1.9.0';

/** Header used to carry the server password instead of the legacy `?guid=`. */
export const AUTH_HEADER = 'Authorization';

/** Scheme prefix for the bearer-style auth header value. */
export const AUTH_SCHEME = 'Bearer';

/**
 * Headers that bypass tunnel interstitial warning pages. Ported from the
 * Flutter app (http_service.dart): ngrok + zrok skip headers.
 */
export const TUNNEL_SKIP_HEADERS: Readonly<Record<string, string>> = {
  'ngrok-skip-browser-warning': 'true',
  skip_zrok_interstitial: 'true',
};

/** Realtime event names emitted by the server (socket) and forwarded via FCM. */
export const SERVER_EVENTS = [
  'new-message',
  'updated-message',
  'typing-indicator',
  'chat-read-status-changed',
  'group-name-change',
  'participant-added',
  'participant-removed',
  'participant-left',
  'ft-call-status-changed',
  'incoming-facetime',
  'imessage-aliases-removed',
  // Server forwards the helper's outgoing-send failure; surfaced as a message error in-app.
  'message-send-error',
  // Server's public URL rotated (zrok tunnel) — the app reconnects to the new origin.
  'new-server',
] as const;

export type ServerEventName = (typeof SERVER_EVENTS)[number];

/**
 * Default page size for incremental sync. Smaller than the Flutter default (1000) on purpose: each
 * page is serialized synchronously by a single-threaded self-hosted server (better-sqlite3 +
 * per-message attachment hydration), so a 1000-row page can peg it at 100% CPU and leave it
 * unresponsive to everything else for many seconds. Smaller pages let the server breathe between
 * them, and the cursor advances per page so a slow/dropped page resumes instead of restarting.
 */
export const SYNC_BATCH_SIZE = 250;

/** Extra fields requested during sync (incremental_sync_manager.dart withQuery). */
export const SYNC_WITH_QUERY = [
  'chats',
  'chats.participants',
  'attachments',
  'attributedBody',
  'messageSummaryInfo',
  'payloadData',
] as const;
