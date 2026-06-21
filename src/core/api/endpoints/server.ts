import { z } from 'zod';
import { ServerInfo } from '@core/models';
import type { HttpClient } from '../http';

/** GET /api/v1/ping — health check. */
export function ping(http: HttpClient): Promise<string> {
  return http.get('/ping', z.string());
}

/** GET /api/v1/server/info — version, capabilities (used for min-version gating). */
export function serverInfo(http: HttpClient): Promise<ServerInfo> {
  return http.get('/server/info', ServerInfo);
}

// ---- Server management (F-9) — mirrors the Flutter HttpService admin routes ----
// NOTE: the HttpClient already unwraps the { status, message, data } envelope (see
// apiResponse), so every schema below describes the INNER `data` payload directly.

/** Generic server ack — the `data` payload for restart routes is null / a string / {}. */
const ServerAck = z.unknown();
export type ServerAck = z.infer<typeof ServerAck>;

/** POST /mac/imessage/restart — restart the macOS Messages app. */
export const restartImessage = (http: HttpClient): Promise<ServerAck> =>
  http.post('/mac/imessage/restart', ServerAck, { json: {} });

/** GET /server/restart/soft — restart the server's services (Private API etc.). */
export const softRestart = (http: HttpClient): Promise<ServerAck> =>
  http.get('/server/restart/soft', ServerAck);

/** GET /server/restart/hard — restart the whole server process (drops the connection). */
export const hardRestart = (http: HttpClient): Promise<ServerAck> =>
  http.get('/server/restart/hard', ServerAck);

const UpdateCheck = z
  .object({
    available: z.boolean().nullish(),
    metadata: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough()
  .nullish();
export type UpdateCheck = z.infer<typeof UpdateCheck>;

/** GET /server/update/check — is a newer server version available. */
export const checkUpdate = (http: HttpClient): Promise<UpdateCheck> =>
  http.get('/server/update/check', UpdateCheck);

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

/** GET /server/statistics/totals — handle/message/chat/attachment counts. */
export const serverStatTotals = (http: HttpClient): Promise<StatTotals> =>
  http.get('/server/statistics/totals', StatTotals);

/** The `data` payload for /server/logs is a raw string (or occasionally an object). */
const ServerLogs = z.unknown();
export type ServerLogs = z.infer<typeof ServerLogs>;

/** GET /server/logs?count=N — recent server log lines. */
export const serverLogs = (http: HttpClient, count = 500): Promise<ServerLogs> =>
  http.get('/server/logs', ServerLogs, { query: { count } });
