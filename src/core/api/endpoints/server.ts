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

// ---- Server management (F-9) — admin routes ----
// AUDIT (F-14): the Gator server does NOT implement these admin routes — every one of them
// 404s. They are kept as named exports (so the Server-Management screen can reference them and
// detect support) but they reject with `UnimplementedEndpointError` instead of issuing a doomed
// request that surfaces as a misleading "connection problem". `SERVER_MANAGEMENT_SUPPORTED`
// lets the UI hide/disable the actions. If a future server adds these routes, restore the real
// HTTP calls here and flip the flag.

/** False while the Gator server implements none of the admin routes below (they 404). */
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

const StatTotals = z
  .object({
    handles: z.number().nullish(),
    messages: z.number().nullish(),
    chats: z.number().nullish(),
    attachments: z.number().nullish(),
  })
  .passthrough()
  .nullish();
export type StatTotals = z.infer<typeof StatTotals>;

/** GET /server/statistics/totals — entity counts. UNIMPLEMENTED on Gator. */
export const serverStatTotals = (_http: HttpClient): Promise<StatTotals> =>
  Promise.reject(new UnimplementedEndpointError('/server/statistics/totals'));

/** The `data` payload for /server/logs is a raw string (or occasionally an object). */
const ServerLogs = z.unknown();
export type ServerLogs = z.infer<typeof ServerLogs>;

/** GET /server/logs?count=N — recent server log lines. UNIMPLEMENTED on Gator. */
export const serverLogs = (_http: HttpClient, _count = 500): Promise<ServerLogs> =>
  Promise.reject(new UnimplementedEndpointError('/server/logs'));
