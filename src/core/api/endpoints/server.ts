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
 * False for the actions Gator only exposes on the LOCAL admin console (restart / logs / update
 * check) — a remote app can't invoke them (403 / unimplemented), so the UI hides them.
 * Statistics are served on the password path and handled separately.
 */
export const SERVER_MANAGEMENT_SUPPORTED = false;

/** Generic server ack — the `data` payload for restart routes is null / a string / {}. */
const ServerAck = z.unknown();
export type ServerAck = z.infer<typeof ServerAck>;

/** POST /mac/imessage/restart — restart the macOS Messages app. UNIMPLEMENTED on Gator. */
export const restartImessage = (_http: HttpClient): Promise<ServerAck> =>
  Promise.reject(new UnimplementedEndpointError('/mac/imessage/restart'));

/** GET /server/restart/soft — restart the server's services. UNIMPLEMENTED on Gator. */
export const softRestart = (_http: HttpClient): Promise<ServerAck> =>
  Promise.reject(new UnimplementedEndpointError('/server/restart/soft'));

/** GET /server/restart/hard — restart the whole server process. UNIMPLEMENTED on Gator. */
export const hardRestart = (_http: HttpClient): Promise<ServerAck> =>
  Promise.reject(new UnimplementedEndpointError('/server/restart/hard'));

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
  images: number;
  videos: number;
}

// The dispatcher's stat channels: get-message-count → a plain number;
// get-chat-image-count / get-chat-video-count → [{ media_count }].
const MediaCount = z.array(z.object({ media_count: z.number() }).passthrough()).nullish();

/**
 * Server statistics via the admin-command dispatcher (password-authed): total messages + image
 * and video attachment counts. Replaces the old stub — these channels are NOT admin-only, so a
 * remote client can read them.
 */
export async function serverStatTotals(http: HttpClient): Promise<StatTotals> {
  const [messages, images, videos] = await Promise.all([
    adminCommand(http, 'get-message-count', z.number().nullish()),
    adminCommand(http, 'get-chat-image-count', MediaCount),
    adminCommand(http, 'get-chat-video-count', MediaCount),
  ]);
  return {
    messages: messages ?? 0,
    images: images?.[0]?.media_count ?? 0,
    videos: videos?.[0]?.media_count ?? 0,
  };
}

/** The `data` payload for /server/logs is a raw string (or occasionally an object). */
const ServerLogs = z.unknown();
export type ServerLogs = z.infer<typeof ServerLogs>;

/** GET /server/logs?count=N — recent server log lines. UNIMPLEMENTED on Gator. */
export const serverLogs = (_http: HttpClient, _count = 500): Promise<ServerLogs> =>
  Promise.reject(new UnimplementedEndpointError('/server/logs'));
