import { z } from 'zod';
import { ServerInfo } from '@core/models';
import { UnimplementedEndpointError } from '../errors';
import type { HttpClient } from '../http';

/** GET /api/v1/ping — health check. The server returns `data: { pong: true }`. */
const Pong = z.object({ pong: z.boolean() }).passthrough();
export type Pong = z.infer<typeof Pong>;
/** `retry: false` — a health/reachability probe must fail fast, not mask a down server by retrying. */
export function ping(http: HttpClient): Promise<Pong> {
  return http.get('/ping', Pong, { retry: false });
}

/** GET /api/v1/server/info — version, capabilities (used for min-version gating). */
export function serverInfo(http: HttpClient): Promise<ServerInfo> {
  return http.get('/server/info', ServerInfo);
}

// ---- Server management (F-9) ----
// Gator routes admin operations through one password-authed dispatch endpoint,
// `POST /api/v1/admin/command` with `{ channel, data? }`. READ/STATUS channels (statistics,
// status) are served on the normal password path; DESTRUCTIVE channels (reinject-helper /
// "restart Messages", config writes, TLS, …) are gated to the trusted LOCAL admin console and
// return 403 to a remote client — so restart / logs / update-check are NOT available from the
// app and stay stubbed below. Statistics ARE available and are wired to the dispatcher.

/**
 * Invoke a Gator admin-command channel over the password-authed dispatcher. The server wraps
 * the channel result in the standard envelope; `http.post` unwraps + validates it with `schema`.
 */
export function adminCommand<T>(
  http: HttpClient,
  channel: string,
  schema: z.ZodType<T>,
  data?: unknown,
): Promise<T> {
  return http.post('/admin/command', schema, { json: { channel, data } });
}

/**
 * True: restart (iMessage / services / server) and log-fetch are wired to the password-authed
 * admin-command dispatcher, so the UI shows the ACTIONS section. Update-check is the one action
 * that stays unimplemented on the Gator fork (`checkUpdate` still rejects and isn't surfaced).
 */
export const SERVER_MANAGEMENT_SUPPORTED = true;

/** Generic server ack — the restart channels return `{ success, ... }`. */
const ServerAck = z.unknown();
export type ServerAck = z.infer<typeof ServerAck>;

/** Relaunch the macOS Messages/FaceTime helper apps ("Restart iMessage") via the dispatcher. */
export const restartImessage = (http: HttpClient): Promise<ServerAck> =>
  adminCommand(http, 'restart-imessage', ServerAck);

/** Soft restart — reload the Private API helper and bounce the tunnel, no process exit. */
export const softRestart = (http: HttpClient): Promise<ServerAck> =>
  adminCommand(http, 'soft-restart', ServerAck);

/** Hard restart — exit the daemon so launchd (KeepAlive) respawns it (briefly drops the link). */
export const hardRestart = (http: HttpClient): Promise<ServerAck> =>
  adminCommand(http, 'hard-restart', ServerAck);

const UpdateCheck = z
  .object({
    available: z.boolean().nullish(),
    metadata: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough()
  .nullish();
export type UpdateCheck = z.infer<typeof UpdateCheck>;

/** GET /server/update/check — newer server version available? UNIMPLEMENTED on Gator. */
export const checkUpdate = (_http: HttpClient): Promise<UpdateCheck> =>
  Promise.reject(new UnimplementedEndpointError('/server/update/check'));

export interface StatTotals {
  messages: number;
  chats: number;
  handles: number;
  attachments: number;
  images: number;
  videos: number;
  locations: number;
}

// The dispatcher's stat channels: get-message-count / get-chat-count / get-handle-count → a
// plain number; the media counts (attachment/image/video/location) → [{ media_count }].
const MediaCount = z.array(z.object({ media_count: z.number() }).passthrough()).nullish();
// Tolerate the dispatcher's `[]` unknown-channel sentinel (an older server without a given count
// channel): accept a number OR an array, and `asCount` coerces a non-number to 0 — so version
// skew degrades gracefully instead of throwing and breaking the whole stats fetch.
const CountNum = z.union([z.number(), z.array(z.unknown())]).nullish();
const asCount = (v: number | unknown[] | null | undefined): number => (typeof v === 'number' ? v : 0);

/**
 * Server statistics via the admin-command dispatcher (password-authed): total messages, chats,
 * handles, and attachment counts (all / image / video / location). These channels are NOT
 * admin-only, so a remote client can read them.
 */
export async function serverStatTotals(http: HttpClient): Promise<StatTotals> {
  const [messages, chats, handles, attachments, images, videos, locations] = await Promise.all([
    adminCommand(http, 'get-message-count', CountNum),
    adminCommand(http, 'get-chat-count', CountNum),
    adminCommand(http, 'get-handle-count', CountNum),
    adminCommand(http, 'get-chat-attachment-count', MediaCount),
    adminCommand(http, 'get-chat-image-count', MediaCount),
    adminCommand(http, 'get-chat-video-count', MediaCount),
    adminCommand(http, 'get-chat-location-count', MediaCount),
  ]);
  return {
    messages: asCount(messages),
    chats: asCount(chats),
    handles: asCount(handles),
    attachments: attachments?.[0]?.media_count ?? 0,
    images: images?.[0]?.media_count ?? 0,
    videos: videos?.[0]?.media_count ?? 0,
    locations: locations?.[0]?.media_count ?? 0,
  };
}

/** The `get-logs` channel returns `{ logs: string }` (a newline-joined, timestamped tail). */
const ServerLogs = z.object({ logs: z.string().nullish() }).passthrough().nullish();

/** Recent server log lines via the admin-command dispatcher (password-authed). */
export function serverLogs(http: HttpClient, count = 500): Promise<string> {
  return adminCommand(http, 'get-logs', ServerLogs, { count }).then((r) => r?.logs ?? '');
}

// ---- Server health / diagnostics ----
// All read-only admin-command channels below are NOT in the server's ADMIN_ONLY_CHANNELS, so a
// remote password-authed client (the app) can read them. They back the Server Health screen.

/** Messages + FaceTime Private-API helper connectivity. */
const PrivateApiStatus = z
  .object({
    connected: z.boolean().nullish(),
    enabled: z.boolean().nullish(),
    ft_connected: z.boolean().nullish(),
    ft_enabled: z.boolean().nullish(),
  })
  .passthrough()
  .nullish();
export type PrivateApiStatus = z.infer<typeof PrivateApiStatus>;
export const privateApiStatus = (http: HttpClient): Promise<PrivateApiStatus> =>
  adminCommand(http, 'get-private-api-status', PrivateApiStatus);

/** Server environment: version, platform, node, and Find My / macOS capability flags. */
const ServerEnv = z
  .object({
    version: z.string().nullish(),
    platform: z.string().nullish(),
    node: z.string().nullish(),
    findmyNeedsKeys: z.boolean().nullish(),
    isMinMonterey: z.boolean().nullish(),
  })
  .passthrough()
  .nullish();
export type ServerEnv = z.infer<typeof ServerEnv>;
export const serverEnv = (http: HttpClient): Promise<ServerEnv> =>
  adminCommand(http, 'get-env', ServerEnv);

/** Find My decryption-key import status (per key: present + valid). */
const KeyState = z.object({ present: z.boolean().nullish(), valid: z.boolean().nullish() }).passthrough();
const FindMyKeysStatus = z
  .object({ LocalStorage: KeyState.nullish(), FMIP: KeyState.nullish(), FMF: KeyState.nullish() })
  .passthrough()
  .nullish();
export type FindMyKeysStatus = z.infer<typeof FindMyKeysStatus>;
export const findMyKeysStatus = (http: HttpClient): Promise<FindMyKeysStatus> =>
  adminCommand(http, 'get-findmy-keys-status', FindMyKeysStatus);

/** FCM (push) configuration status. */
const FcmStatus = z
  .object({
    configured: z.boolean().nullish(),
    projectId: z.string().nullish(),
    clientEmail: z.string().nullish(),
    oauthClientConfigured: z.boolean().nullish(),
  })
  .passthrough()
  .nullish();
export type FcmStatus = z.infer<typeof FcmStatus>;
export const fcmStatus = (http: HttpClient): Promise<FcmStatus> =>
  adminCommand(http, 'get-fcm-status', FcmStatus);

/** zrok tunnel status (running + public URL). */
const ZrokStatus = z
  .object({ running: z.boolean().nullish(), url: z.string().nullish(), available: z.boolean().nullish() })
  .passthrough()
  .nullish();
export type ZrokStatus = z.infer<typeof ZrokStatus>;
export const zrokStatus = (http: HttpClient): Promise<ZrokStatus> =>
  adminCommand(http, 'get-zrok-status', ZrokStatus);

/** The server's detected public IP (or null). */
const PublicIp = z.object({ ip: z.string().nullish() }).passthrough().nullish();
export const publicIp = (http: HttpClient): Promise<string | null> =>
  adminCommand(http, 'get-public-ip', PublicIp).then((r) => r?.ip ?? null);

/** Active TLS/cert info (loose — domain/expiry/issuer/mode vary by mode). */
const TlsStatus = z.record(z.string(), z.unknown()).nullish();
export type TlsStatus = z.infer<typeof TlsStatus>;
export const tlsStatus = (http: HttpClient): Promise<TlsStatus> =>
  adminCommand(http, 'get-tls-status', TlsStatus);

/** In-memory server alert log. */
const ServerAlert = z
  .object({
    id: z.string(),
    type: z.string().nullish(),
    value: z.string().nullish(),
    created: z.number().nullish(),
    isRead: z.boolean().nullish(),
  })
  .passthrough();
export type ServerAlert = z.infer<typeof ServerAlert>;
const ServerAlerts = z.array(ServerAlert).nullish();
export const serverAlerts = (http: HttpClient): Promise<ServerAlert[]> =>
  adminCommand(http, 'get-alerts', ServerAlerts).then((a) => a ?? []);
export const clearServerAlerts = (http: HttpClient): Promise<unknown> =>
  adminCommand(http, 'clear-alerts', z.unknown());

/** GET /admin/status — server version + uptime (ms). */
const AdminStatus = z
  .object({ version: z.string().nullish(), uptimeMs: z.number().nullish() })
  .passthrough()
  .nullish();
export type AdminStatus = z.infer<typeof AdminStatus>;
export const adminStatus = (http: HttpClient): Promise<AdminStatus> =>
  http.get('/admin/status', AdminStatus);
