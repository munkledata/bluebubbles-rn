import { z } from 'zod/v4';
import { ServerInfo } from '@core/models';
import { ApiError, UnimplementedEndpointError } from '../errors';
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

/** Narrow, read-only account status. The older iCloud alias-management routes stay retired. */
const IMessageAccountStatus = z
  .object({
    appleId: z.string().max(512).nullable(),
    displayName: z.string().max(512).nullable(),
    activeAlias: z.string().max(512).nullable(),
    aliases: z.array(z.string().min(1).max(512)).max(32),
    vettedAliases: z.array(z.string().min(1).max(512)).max(32),
    loginStatusMessage: z.string().max(2048).nullable(),
  })
  .strict();
export type IMessageAccountStatus = z.infer<typeof IMessageAccountStatus>;

export function imessageAccountStatus(
  http: HttpClient,
  signal?: AbortSignal,
): Promise<IMessageAccountStatus> {
  return typedRoute('/imessage/account/status', () =>
    http.get('/imessage/account/status', IMessageAccountStatus, { signal }),
  );
}

const IMessageAliasChangeResult = z.object({ activeAlias: z.string().min(1).max(254) }).strict();

/** One explicitly chosen, vetted send-from alias; never use the retired iCloud mutation route. */
export function changeImessageActiveAlias(
  http: HttpClient,
  alias: string,
  signal?: AbortSignal,
): Promise<z.infer<typeof IMessageAliasChangeResult>> {
  const selected = z
    .string()
    .min(1)
    .max(254)
    .regex(/^[^\x00-\x1f\x7f]+$/)
    .parse(alias);
  return typedRoute('/imessage/account/alias', () =>
    http.post('/imessage/account/alias', IMessageAliasChangeResult, {
      json: { alias: selected },
      retry: false,
      captureErrorDetail: true,
      signal,
    }),
  );
}

// ---- Server management (F-9) ----
// Current Gator servers expose typed password-authenticated routes for statistics and health.
// Remote restart is intentionally unsupported and has no client wrapper.

/** Preserve the existing unsupported-version presentation without retrying a retired route. */
async function typedRoute<T>(path: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      throw new UnimplementedEndpointError(path);
    }
    throw e;
  }
}

/** Remote restart stays local to the Mac; this client must not expose it. */
export const SERVER_MANAGEMENT_SUPPORTED = false;

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

/** All-time message/photo/video totals from the supported typed statistics route. */
export async function serverStatTotals(
  http: HttpClient,
  signal?: AbortSignal,
): Promise<StatTotals> {
  const snapshot = await typedRoute('/statistics/snapshot', () =>
    http.post('/statistics/snapshot', StatisticsSnapshot, {
      json: { range: 'all-time' },
      signal,
    }),
  );
  return {
    messages: snapshot.messageCount,
    images: snapshot.imageCount,
    videos: snapshot.videoCount,
  };
}

// ---- Server health / diagnostics ----
// Each read uses its current typed password-authenticated route. A route-level 404 becomes an
// explicit unsupported-version result without retrying any retired compatibility transport.

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
  typedRoute('/server/environment', () =>
    http.get('/server/environment', TypedServerEnv, { signal }),
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
  typedRoute('/admin/findmy/keys/status', () =>
    http.get('/admin/findmy/keys/status', TypedFindMyKeysStatus, { signal }),
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
  typedRoute('/notifications/fcm/status', () =>
    http.get('/notifications/fcm/status', TypedFcmStatus, { signal }),
  );

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
  typedRoute('/admin/network/public-ip', () =>
    http.get('/admin/network/public-ip', TypedPublicIp, { signal }),
  ).then((r) => r.ip);

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
  typedRoute('/tls/status', () =>
    http.get('/tls/status', TypedTlsStatus, { signal }).then((status) => ({
      ...status,
      // Presentation aliases for the existing health screen while retaining every canonical
      // typed field for future callers.
      enabled: status.configuredEnabled,
      mode: status.serving
        ? (status.effectiveCertificateSource ?? status.configuredMode)
        : status.configuredEnabled
          ? 'not-serving'
          : 'off',
      domain: status.certificate?.domain ?? null,
    })),
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
  typedRoute('/alerts', () =>
    http.get('/alerts', TypedServerAlerts, { signal }).then((r) => r.alerts),
  );
export const clearServerAlerts = (http: HttpClient): Promise<unknown> =>
  typedRoute('/alerts', () => http.delete('/alerts', ClearServerAlertsResult));

/** GET /admin/status — server version + uptime (ms). */
const AdminStatus = z
  .object({
    version: z.string().min(1),
    uptimeMs: z.number().int().nonnegative(),
  })
  .strict();
export type AdminStatus = z.infer<typeof AdminStatus>;
export const adminStatus = (http: HttpClient, signal?: AbortSignal): Promise<AdminStatus> =>
  typedRoute('/admin/status', () => http.get('/admin/status', AdminStatus, { signal }));
