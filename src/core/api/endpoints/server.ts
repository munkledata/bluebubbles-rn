import { z } from 'zod/v4';
import { ServerInfo } from '@core/models';
import { ApiError, UnimplementedEndpointError, isUnimplementedEndpoint } from '../errors';
import type { HttpClient } from '../http';

/** GET /api/v1/ping — health check. The server returns `data: { pong: true }`. */
const Pong = z.object({ pong: z.boolean() }).loose();
export type Pong = z.infer<typeof Pong>;
/** `retry: false` — a health/reachability probe must fail fast, not mask a down server by retrying. */
export function ping(http: HttpClient, signal?: AbortSignal): Promise<Pong> {
  return http.get('/ping', Pong, { retry: false, signal });
}

/** GET /api/v1/server/info — version, capabilities (used for min-version gating). */
export function serverInfo(http: HttpClient, signal?: AbortSignal): Promise<ServerInfo> {
  return http.get('/server/info', ServerInfo, { signal });
}

// ---- Server management (F-9) ----
// Current Gator servers expose typed password-authenticated routes for statistics and health.
// Older Gator builds used `POST /api/v1/admin/command`; those reads retain a narrow compatibility
// fallback below, used only when the typed route itself returns 404. Restart/log operations still
// use the dispatcher because they do not yet have equivalent password-authenticated typed routes.

/**
 * Invoke a Gator admin-command channel over the password-authed dispatcher. The server wraps
 * the channel result in the standard envelope; `http.post` unwraps + validates it with `schema`.
 */
export async function adminCommand<T>(
  http: HttpClient,
  channel: string,
  schema: z.ZodType<T>,
  data?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await http.post('/admin/command', schema, { json: { channel, data }, signal });
  } catch (e) {
    // A 404 means the dispatcher route itself is unreachable — a server without it (stock
    // BlueBubbles / pre-dispatcher Gator) or a reverse proxy blocking /admin/*. Surface that as
    // "unsupported" so callers don't blame the connection. Non-404 errors propagate unchanged.
    if (e instanceof ApiError && e.status === 404) {
      throw new UnimplementedEndpointError('/admin/command');
    }
    throw e;
  }
}

/** Prefer a typed route; use its retired dispatcher equivalent only when that route is absent. */
async function typedRouteOrLegacy<T>(
  typedRequest: () => Promise<T>,
  legacyRequest: () => Promise<T>,
): Promise<T> {
  try {
    return await typedRequest();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return legacyRequest();
    throw e;
  }
}

/** Current Gator has no password-authenticated remote restart or log-reading routes. */
export const SERVER_MANAGEMENT_SUPPORTED = false;

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
  .loose()
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

const StatisticsSnapshot = z
  .object({
    range: z.literal('all-time'),
    after: z.null(),
    messageCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    imageCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    videoCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    topGroup: z.string().max(2_048),
    bestFriend: z.string().max(2_048),
  })
  .strict();

// Retired dispatcher fallback: message count is a number; media counts are [{ media_count }].
const MediaCount = z.array(z.object({ media_count: z.number() }).loose()).nullish();
const CountNum = z.union([z.number(), z.array(z.unknown())]).nullish();
const asCount = (v: number | unknown[] | null | undefined): number =>
  typeof v === 'number' ? v : 0;

async function legacyServerStatTotals(http: HttpClient, signal?: AbortSignal): Promise<StatTotals> {
  let anyOk = false;
  let sawOtherError = false;
  const settle = async <T>(p: Promise<T>): Promise<T | null> => {
    try {
      const v = await p;
      anyOk = true;
      return v;
    } catch (e) {
      if (signal?.aborted) throw e;
      if (!isUnimplementedEndpoint(e)) sawOtherError = true;
      return null;
    }
  };
  const [messages, images, videos] = await Promise.all([
    settle(adminCommand(http, 'get-message-count', CountNum, undefined, signal)),
    settle(adminCommand(http, 'get-chat-image-count', MediaCount, undefined, signal)),
    settle(adminCommand(http, 'get-chat-video-count', MediaCount, undefined, signal)),
  ]);
  if (!anyOk && !sawOtherError) throw new UnimplementedEndpointError('/admin/command');
  if (!anyOk) throw new Error('Server statistics unavailable');
  return {
    messages: asCount(messages),
    images: images?.[0]?.media_count ?? 0,
    videos: videos?.[0]?.media_count ?? 0,
  };
}

export interface ServerStatTotalsOptions {
  /** Scoped clients must not turn a missing typed route into an admin-command attempt. */
  readonly allowLegacyFallback?: boolean;
}

/** All-time message/photo/video totals, with an opt-out dispatcher fallback for scoped clients. */
export async function serverStatTotals(
  http: HttpClient,
  signal?: AbortSignal,
  options: ServerStatTotalsOptions = {},
): Promise<StatTotals> {
  try {
    const snapshot = await http.post('/statistics/snapshot', StatisticsSnapshot, {
      json: { range: 'all-time' },
      signal,
    });
    return {
      messages: snapshot.messageCount,
      images: snapshot.imageCount,
      videos: snapshot.videoCount,
    };
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
    if (options.allowLegacyFallback === false) {
      throw new UnimplementedEndpointError('/statistics/snapshot');
    }
    return legacyServerStatTotals(http, signal);
  }
}

/** The `get-logs` channel returns `{ logs: string }` (a newline-joined, timestamped tail). */
const ServerLogs = z.object({ logs: z.string().nullish() }).loose().nullish();

/** Recent server log lines via the admin-command dispatcher (password-authed). */
export function serverLogs(http: HttpClient, count = 500): Promise<string> {
  return adminCommand(http, 'get-logs', ServerLogs, { count }).then((r) => r?.logs ?? '');
}

// ---- Server health / diagnostics ----
// Each read prefers the current typed password-authenticated route. The old dispatcher channel is
// reached only after a typed-route 404, which preserves compatibility without masking auth,
// transport, or response-validation failures.

/** Messages + FaceTime Private-API helper connectivity. */
const PrivateApiStatus = z
  .object({
    connected: z.boolean().nullish(),
    enabled: z.boolean().nullish(),
    ft_connected: z.boolean().nullish(),
    ft_enabled: z.boolean().nullish(),
  })
  .loose()
  .nullish();
const TypedPrivateApiStatus = z
  .object({
    available: z.boolean(),
    connected: z.boolean(),
    enabled: z.boolean(),
    unavailable_reason: z.literal('trusted_helper_unavailable').nullable(),
    ft_available: z.boolean(),
    ft_connected: z.boolean(),
    ft_enabled: z.boolean(),
    ft_unavailable_reason: z.literal('trusted_helper_unavailable').nullable(),
  })
  .strict()
  .superRefine((status, context) => {
    for (const target of [
      {
        available: status.available,
        connected: status.connected,
        reason: status.unavailable_reason,
        path: 'unavailable_reason',
      },
      {
        available: status.ft_available,
        connected: status.ft_connected,
        reason: status.ft_unavailable_reason,
        path: 'ft_unavailable_reason',
      },
    ] as const) {
      if (target.connected && !target.available) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [target.path],
          message: 'a connected helper must be available',
        });
      }
      if ((target.reason === null) !== target.available) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [target.path],
          message: 'availability and unavailable reason must agree',
        });
      }
    }
  });
export type PrivateApiStatus = z.infer<typeof PrivateApiStatus>;
export const privateApiStatus = (
  http: HttpClient,
  signal?: AbortSignal,
): Promise<PrivateApiStatus> =>
  typedRouteOrLegacy<PrivateApiStatus>(
    () => http.get('/private-api/status', TypedPrivateApiStatus, { signal }),
    () => adminCommand(http, 'get-private-api-status', PrivateApiStatus, undefined, signal),
  );

/** Server environment: version, platform, node, and Find My / macOS capability flags. */
const ServerEnv = z
  .object({
    version: z.string().nullish(),
    platform: z.string().nullish(),
    node: z.string().nullish(),
    findmyNeedsKeys: z.boolean().nullish(),
    isMinMonterey: z.boolean().nullish(),
  })
  .loose()
  .nullish();
const TypedServerEnv = z
  .object({
    version: z.string().min(1).max(128),
    platform: z.string().min(1).max(64),
    node: z.string().min(1).max(128),
    findmyNeedsKeys: z.boolean(),
    isMinMonterey: z.boolean(),
  })
  .strict();
export type ServerEnv = z.infer<typeof ServerEnv>;
export const serverEnv = (http: HttpClient, signal?: AbortSignal): Promise<ServerEnv> =>
  typedRouteOrLegacy<ServerEnv>(
    () => http.get('/server/environment', TypedServerEnv, { signal }),
    () => adminCommand(http, 'get-env', ServerEnv, undefined, signal),
  );

/** Find My decryption-key import status (per key: present + valid). */
const KeyState = z.object({ present: z.boolean().nullish(), valid: z.boolean().nullish() }).loose();
const FindMyKeysStatus = z
  .object({ LocalStorage: KeyState.nullish(), FMIP: KeyState.nullish(), FMF: KeyState.nullish() })
  .loose()
  .nullish();
const TypedKeyState = z
  .object({ present: z.boolean(), valid: z.boolean() })
  .strict()
  .superRefine((status, context) => {
    if (status.valid && !status.present) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['valid'],
        message: 'a valid Find My key must be present',
      });
    }
  });
const TypedFindMyKeysStatus = z
  .object({ LocalStorage: TypedKeyState, FMIP: TypedKeyState, FMF: TypedKeyState })
  .strict();
export type FindMyKeysStatus = z.infer<typeof FindMyKeysStatus>;
export const findMyKeysStatus = (
  http: HttpClient,
  signal?: AbortSignal,
): Promise<FindMyKeysStatus> =>
  typedRouteOrLegacy<FindMyKeysStatus>(
    () => http.get('/admin/findmy/keys/status', TypedFindMyKeysStatus, { signal }),
    () => adminCommand(http, 'get-findmy-keys-status', FindMyKeysStatus, undefined, signal),
  );

/** FCM (push) configuration status. */
const FcmStatus = z
  .object({
    configured: z.boolean().nullish(),
    projectId: z.string().nullish(),
    clientEmail: z.string().nullish(),
    oauthClientConfigured: z.boolean().nullish(),
  })
  .loose()
  .nullish();
const TypedFcmStatus = z
  .object({
    configured: z.boolean(),
    projectId: z.string().min(1).max(256).nullable(),
    clientEmail: z.string().min(1).max(512).nullable(),
    oauthClientConfigured: z.boolean(),
  })
  .strict()
  .superRefine((status, context) => {
    if ((status.projectId === null) !== (status.clientEmail === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['projectId'],
        message: 'projectId and clientEmail must both be present or both be null',
      });
    }
    if (status.configured && status.projectId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['configured'],
        message: 'configured FCM status requires an account identity',
      });
    }
  });
export type FcmStatus = z.infer<typeof FcmStatus>;
export const fcmStatus = (http: HttpClient, signal?: AbortSignal): Promise<FcmStatus> =>
  typedRouteOrLegacy<FcmStatus>(
    () => http.get('/notifications/fcm/status', TypedFcmStatus, { signal }),
    () => adminCommand(http, 'get-fcm-status', FcmStatus, undefined, signal),
  );

/** zrok tunnel status (running + public URL). */
const ZrokStatus = z
  .object({
    running: z.boolean().nullish(),
    url: z.string().nullish(),
    available: z.boolean().nullish(),
  })
  .loose()
  .nullish();
export type ZrokStatus = z.infer<typeof ZrokStatus>;
export const zrokStatus = (http: HttpClient, signal?: AbortSignal): Promise<ZrokStatus> =>
  adminCommand(http, 'get-zrok-status', ZrokStatus, undefined, signal);

/** The bridge accepted the server-owned Firefox cookies immediately. */
const RcsReauthAppliedResult = z
  .object({
    reauthed: z.literal(true),
    ok: z.literal(true),
    staged: z.undefined().optional(),
    connected: z.boolean(),
    stale: z.boolean(),
    message: z.string(),
  })
  .strict();

/** The server safely staged the cookies because the bridge was not running yet. */
const RcsReauthStagedResult = z
  .object({
    reauthed: z.literal(false),
    staged: z.literal(true),
    ok: z.undefined().optional(),
    connected: z.literal(false),
    stale: z.boolean(),
    message: z.string(),
  })
  .strict();

/** Result of asking the server to re-authenticate the RCS bridge with its own cookies. */
const RcsReauthResult = z.discriminatedUnion('reauthed', [
  RcsReauthAppliedResult,
  RcsReauthStagedResult,
]);
export type RcsReauthResult = z.infer<typeof RcsReauthResult>;

/**
 * Ask the SERVER to re-authenticate the RCS bridge using the Google cookies already sitting in
 * its own Firefox profile.
 *
 * No credentials travel from the phone — the request body is empty. That is what makes this
 * safe to expose to a password-authed app when every other RCS pairing route is dashboard-only:
 * those take cookies as INPUT, this one takes none. It exists because the "RCS disconnected —
 * re-authenticate on the server dashboard" notice was impossible to act on from the phone.
 */
export const rcsReauthNow = (http: HttpClient): Promise<RcsReauthResult> =>
  http.post('/rcs/reauth-now', RcsReauthResult, { json: {} });

/** The server's detected public IP (or null). */
const PublicIp = z.object({ ip: z.string().nullish() }).loose().nullish();
const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc01fc400, 24],
  [0xc034c100, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc0af3000, 24],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 3],
];

function isCanonicalGloballyPublicIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;

  let numeric = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return false;
    const octet = Number(part);
    if (octet > 255) return false;
    numeric = numeric * 256 + octet;
  }

  const address = numeric >>> 0;
  return !BLOCKED_IPV4_RANGES.some(([network, prefix]) => {
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    return (address & mask) >>> 0 === (network & mask) >>> 0;
  });
}

const TypedPublicIp = z
  .object({
    ip: z
      .string()
      .refine(isCanonicalGloballyPublicIpv4, 'public IPv4 address is invalid')
      .nullable(),
  })
  .strict();
export const publicIp = (http: HttpClient, signal?: AbortSignal): Promise<string | null> =>
  typedRouteOrLegacy(
    () => http.get('/admin/network/public-ip', TypedPublicIp, { signal }),
    () => adminCommand(http, 'get-public-ip', PublicIp, undefined, signal),
  ).then((r) => r?.ip ?? null);

/** Active TLS/certificate information. */
const TlsStatus = z.record(z.string(), z.unknown()).nullish();
const TlsMode = z.enum(['self-signed', 'letsencrypt', 'custom']);
const TlsCertificateExpiry = z
  .string()
  .length(24)
  .datetime()
  .refine((value) => {
    try {
      return new Date(value).toISOString() === value;
    } catch {
      return false;
    }
  }, 'certificate expiry must be a canonical ISO timestamp');
const TypedTlsStatus = z
  .object({
    configuredEnabled: z.boolean(),
    configuredPort: z.number().int().min(1).max(65_535),
    configuredMode: TlsMode,
    configuredCertificateSource: TlsMode,
    serving: z.boolean(),
    boundPort: z.number().int().min(1).max(65_535).nullable(),
    effectiveCertificateSource: TlsMode.nullable(),
    certificate: z
      .object({
        domain: z.string().max(2_048).nullable(),
        certExpiry: TlsCertificateExpiry.nullable(),
        issuer: z.string().max(8_192).nullable(),
        subjectAltName: z.string().max(32_768).nullable(),
      })
      .strict()
      .nullable(),
    fallback: z.boolean(),
    degraded: z.boolean(),
    restartRequired: z.boolean(),
  })
  .strict()
  .superRefine((status, context) => {
    const liveFields = [
      status.boundPort !== null,
      status.effectiveCertificateSource !== null,
      status.certificate !== null,
    ];
    if (
      (status.serving && !liveFields.every(Boolean)) ||
      (!status.serving && liveFields.some(Boolean))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['serving'],
        message: 'serving status and active listener fields must agree',
      });
    }
    if (!status.serving && status.fallback) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fallback'],
        message: 'a fallback certificate requires a serving listener',
      });
    }
    if (status.fallback && status.effectiveCertificateSource !== 'self-signed') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effectiveCertificateSource'],
        message: 'fallback material must be self-signed',
      });
    }
    if (status.fallback && !status.degraded) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['degraded'],
        message: 'fallback material is a degraded recovery state',
      });
    }
    if (
      status.configuredCertificateSource !== status.configuredMode &&
      status.configuredCertificateSource !== 'custom'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['configuredCertificateSource'],
        message: 'only complete custom certificate paths may override the configured mode',
      });
    }
    if (status.configuredEnabled !== status.serving && !status.restartRequired) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['restartRequired'],
        message: 'configured and effective listener enablement differ',
      });
    }
    if (status.serving && status.boundPort !== status.configuredPort && !status.restartRequired) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['restartRequired'],
        message: 'configured and bound listener ports differ',
      });
    }
    if (
      status.serving &&
      status.effectiveCertificateSource !== status.configuredCertificateSource &&
      !status.restartRequired
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['restartRequired'],
        message: 'configured and effective certificate sources differ',
      });
    }
  });
export type TlsStatus = z.infer<typeof TlsStatus>;
export const tlsStatus = (http: HttpClient, signal?: AbortSignal): Promise<TlsStatus> =>
  typedRouteOrLegacy<TlsStatus>(
    () =>
      http.get('/tls/status', TypedTlsStatus, { signal }).then((status) => ({
        ...status,
        // Compatibility aliases for the existing health presentation while retaining every
        // canonical typed field for future callers.
        enabled: status.configuredEnabled,
        mode: status.serving
          ? (status.effectiveCertificateSource ?? status.configuredMode)
          : status.configuredEnabled
            ? 'not-serving'
            : 'off',
        domain: status.certificate?.domain ?? null,
      })),
    () => adminCommand(http, 'get-tls-status', TlsStatus, undefined, signal),
  );

/** In-memory server alert log. */
const ServerAlert = z
  .object({
    id: z.string(),
    type: z.string().nullish(),
    value: z.string().nullish(),
    created: z.number().nullish(),
    isRead: z.boolean().nullish(),
  })
  .loose();
export type ServerAlert = z.infer<typeof ServerAlert>;
const ServerAlerts = z.array(ServerAlert).nullish();
const TypedServerAlert = z
  .object({
    id: z.string().min(1).max(256),
    type: z.string().min(1).max(64),
    value: z.string().max(16_384),
    created: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    isRead: z.boolean(),
  })
  .strict();
const TypedServerAlerts = z.object({ alerts: z.array(TypedServerAlert) }).strict();
const ClearServerAlertsResult = z
  .object({ removed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
  .strict();
export const serverAlerts = (http: HttpClient, signal?: AbortSignal): Promise<ServerAlert[]> =>
  typedRouteOrLegacy<ServerAlert[]>(
    () => http.get('/alerts', TypedServerAlerts, { signal }).then((r) => r.alerts),
    () => adminCommand(http, 'get-alerts', ServerAlerts, undefined, signal).then((a) => a ?? []),
  );
export const clearServerAlerts = (http: HttpClient): Promise<unknown> =>
  typedRouteOrLegacy<unknown>(
    () => http.delete('/alerts', ClearServerAlertsResult),
    () => adminCommand(http, 'clear-alerts', z.unknown()),
  );

/** GET /admin/status — server version + uptime (ms). */
const AdminStatus = z
  .object({
    version: z.string().min(1),
    uptimeMs: z.number().int().nonnegative(),
  })
  .strict();
export type AdminStatus = z.infer<typeof AdminStatus>;
export async function adminStatus(http: HttpClient, signal?: AbortSignal): Promise<AdminStatus> {
  try {
    return await http.get('/admin/status', AdminStatus, { signal });
  } catch (e) {
    // Same remap as adminCommand: a 404 = route absent or proxy-blocked, i.e. "unsupported".
    if (e instanceof ApiError && e.status === 404) {
      throw new UnimplementedEndpointError('/admin/status');
    }
    throw e;
  }
}
