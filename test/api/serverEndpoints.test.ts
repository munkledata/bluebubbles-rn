// ky is ESM-only; mock it so the endpoint wrappers are testable under ts-jest/CJS.
jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));

/* eslint-disable import/first -- the ESM mock must be installed before these CJS test imports. */
import ky from 'ky';
import { z } from 'zod/v4';
import { HttpClient } from '@core/api/http';
import { ApiError, UnimplementedEndpointError, isUnimplementedEndpoint } from '@core/api/errors';
import * as serverApi from '@core/api/endpoints/server';
import * as findMyApi from '@core/api/endpoints/findmy';
/* eslint-enable import/first */

const mockKy = ky as unknown as jest.Mock;

/** A realistic server response: the payload nested under the { status, message, data } envelope. */
function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ status: 200, message: 'success', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function client(): HttpClient {
  return new HttpClient({ getOrigin: () => 'https://x.test', getPassword: () => 'pw' });
}

function notFound(): Response {
  return new Response(null, { status: 404 });
}

// Compatibility wrappers remain for older servers, but the current product does not advertise
// these remote actions because it has no password-authenticated restart or log routes.
describe('legacy server-management restart/log wrappers', () => {
  it('does not advertise remote server management', () => {
    expect(serverApi.SERVER_MANAGEMENT_SUPPORTED).toBe(false);
  });

  it('checkUpdate stays unimplemented (no HTTP call)', async () => {
    const err = await serverApi.checkUpdate(client()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isUnimplementedEndpoint(err)).toBe(true);
    expect(mockKy).not.toHaveBeenCalled();
  });

  // The channel STRING is the whole contract here: every restart wrapper POSTs the same URL with
  // the same schema, so a copy-paste slip that makes "Hard Restart" send `soft-restart` is
  // invisible to a call-count assertion. Pin the exact channel each wrapper sends.
  it.each([
    ['restartImessage', 'restart-imessage', (h: HttpClient) => serverApi.restartImessage(h)],
    ['softRestart', 'soft-restart', (h: HttpClient) => serverApi.softRestart(h)],
    ['hardRestart', 'hard-restart', (h: HttpClient) => serverApi.hardRestart(h)],
  ])('%s POSTs /admin/command with channel "%s"', async (_name, channel, call) => {
    mockKy.mockResolvedValueOnce(envelope({ success: true }));
    await expect(call(client())).resolves.toBeDefined();
    expect(mockKy).toHaveBeenCalledTimes(1);

    const [url, init] = mockKy.mock.calls[0] as [string, { method: string; json: unknown }];
    expect(url).toBe('https://x.test/api/v1/admin/command');
    expect(init.method).toBe('POST');
    expect(init.json).toEqual({ channel });
    // Guard against the three wrappers collapsing onto one channel.
    expect((init.json as { channel: string }).channel).toBe(channel);
  });

  it('the three restart wrappers send three DISTINCT channels', async () => {
    // Fresh Response per call — a Response body can only be read once.
    mockKy.mockImplementation(async () => envelope({ success: true }));
    await serverApi.restartImessage(client());
    await serverApi.softRestart(client());
    await serverApi.hardRestart(client());
    const channels = mockKy.mock.calls.map(
      (c) => (c[1] as { json: { channel: string } }).json.channel,
    );
    expect(channels).toEqual(['restart-imessage', 'soft-restart', 'hard-restart']);
    expect(new Set(channels).size).toBe(3);
  });

  it('serverLogs sends the get-logs channel with the requested line count', async () => {
    mockKy.mockResolvedValueOnce(envelope({ logs: 'x' }));
    await serverApi.serverLogs(client(), 250);
    expect((mockKy.mock.calls[0] as [string, { json: unknown }])[1].json).toEqual({
      channel: 'get-logs',
      data: { count: 250 },
    });
  });

  it('serverLogs returns the joined log text from the get-logs channel', async () => {
    mockKy.mockResolvedValueOnce(envelope({ logs: 'line one\nline two' }));
    await expect(serverApi.serverLogs(client(), 100)).resolves.toBe('line one\nline two');
  });
});

describe('serverStatTotals prefers the typed statistics route', () => {
  it('maps only Messages, Photos, and Videos from an all-time snapshot', async () => {
    mockKy.mockResolvedValueOnce(
      envelope({
        range: 'all-time',
        after: null,
        messageCount: 1234,
        imageCount: 42,
        videoCount: 7,
        topGroup: 'Family',
        bestFriend: '+15555550123',
      }),
    );

    const res = await serverApi.serverStatTotals(client());
    expect(res).toEqual({ messages: 1234, images: 42, videos: 7 });
    expect(mockKy).toHaveBeenCalledTimes(1);

    const [url, init] = mockKy.mock.calls[0] as [string, { method: string; json: unknown }];
    expect(url).toBe('https://x.test/api/v1/statistics/snapshot');
    expect(init.method).toBe('POST');
    expect(init.json).toEqual({ range: 'all-time' });
  });

  it('falls back after a typed-route 404 and requests only the three legacy totals', async () => {
    mockKy
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(envelope(1234))
      .mockResolvedValueOnce(envelope([{ media_count: 42 }]))
      .mockResolvedValueOnce(envelope([{ media_count: 7 }]));

    const res = await serverApi.serverStatTotals(client());
    expect(res).toEqual({ messages: 1234, images: 42, videos: 7 });
    expect(mockKy).toHaveBeenCalledTimes(4);
    expect((mockKy.mock.calls[0] as [string])[0]).toBe('https://x.test/api/v1/statistics/snapshot');
    expect(
      mockKy.mock.calls.slice(1).map((call) => {
        const [, init] = call as [string, { json: { channel: string } }];
        return init.json.channel;
      }),
    ).toEqual(['get-message-count', 'get-chat-image-count', 'get-chat-video-count']);
  });

  it('does not use the legacy dispatcher for a typed-route auth error', async () => {
    mockKy.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const err = await serverApi.serverStatTotals(client()).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe('unauthorized');
    expect(mockKy).toHaveBeenCalledTimes(1);
  });

  it('does not try the legacy admin dispatcher when a scoped caller opts out', async () => {
    mockKy.mockResolvedValueOnce(notFound());

    const error = await serverApi
      .serverStatTotals(client(), undefined, {
        allowLegacyFallback: false,
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(UnimplementedEndpointError);
    expect(mockKy).toHaveBeenCalledTimes(1);
  });

  it('forwards cancellation to both the typed attempt and the legacy fallback requests', async () => {
    const controller = new AbortController();
    const post = jest.fn(
      async (path: string, _schema: unknown, options: { json: { channel?: string } }) => {
        if (path === '/statistics/snapshot') {
          throw new ApiError('bad_request', 'missing typed route', 404);
        }
        return options.json.channel === 'get-message-count' ? 0 : [];
      },
    );
    const http = { post } as unknown as HttpClient;

    await serverApi.serverStatTotals(http, controller.signal);

    expect(post).toHaveBeenCalledTimes(4);
    for (const call of post.mock.calls) {
      expect(call[2]).toMatchObject({ signal: controller.signal });
    }
  });
});

const typedPrivateApiStatus = {
  available: true,
  connected: true,
  enabled: true,
  unavailable_reason: null,
  ft_available: true,
  ft_connected: false,
  ft_enabled: false,
  ft_unavailable_reason: null,
};
const typedEnvironment = {
  version: '1.10.0',
  platform: 'darwin',
  node: 'v24.19.0',
  findmyNeedsKeys: false,
  isMinMonterey: true,
};
const typedFindMyKeys = {
  LocalStorage: { present: true, valid: true },
  FMIP: { present: true, valid: true },
  FMF: { present: false, valid: false },
};
const typedFcmStatus = {
  configured: true,
  projectId: 'gator-project',
  clientEmail: 'push@gator.example',
  oauthClientConfigured: true,
};
const typedTlsStatus = {
  configuredEnabled: true,
  configuredPort: 1234,
  configuredMode: 'self-signed',
  configuredCertificateSource: 'self-signed',
  serving: true,
  boundPort: 1234,
  effectiveCertificateSource: 'self-signed',
  certificate: {
    domain: 'gator.example',
    certExpiry: '2027-09-08T00:00:00.000Z',
    issuer: 'Gator',
    subjectAltName: 'DNS:gator.example',
  },
  fallback: false,
  degraded: false,
  restartRequired: false,
};
const typedAlert = {
  id: 'alert-1',
  type: 'TEST',
  value: 'A test alert',
  created: 1_700_000_000_000,
  isRead: false,
};

interface TypedHealthRouteCase {
  name: string;
  method: 'GET' | 'DELETE';
  path: string;
  channel: string;
  typedPayload: unknown;
  legacyPayload: unknown;
  expectedTyped: unknown;
  expectedLegacy: unknown;
  call: (http: HttpClient, signal: AbortSignal) => Promise<unknown>;
}

const typedHealthRouteCases: TypedHealthRouteCase[] = [
  {
    name: 'Private API status',
    method: 'GET',
    path: '/private-api/status',
    channel: 'get-private-api-status',
    typedPayload: typedPrivateApiStatus,
    legacyPayload: { connected: true, enabled: true },
    expectedTyped: typedPrivateApiStatus,
    expectedLegacy: { connected: true, enabled: true },
    call: (http, signal) => serverApi.privateApiStatus(http, signal),
  },
  {
    name: 'server environment',
    method: 'GET',
    path: '/server/environment',
    channel: 'get-env',
    typedPayload: typedEnvironment,
    legacyPayload: { version: 'legacy' },
    expectedTyped: typedEnvironment,
    expectedLegacy: { version: 'legacy' },
    call: (http, signal) => serverApi.serverEnv(http, signal),
  },
  {
    name: 'FCM status',
    method: 'GET',
    path: '/notifications/fcm/status',
    channel: 'get-fcm-status',
    typedPayload: typedFcmStatus,
    legacyPayload: { configured: false },
    expectedTyped: typedFcmStatus,
    expectedLegacy: { configured: false },
    call: (http, signal) => serverApi.fcmStatus(http, signal),
  },
  {
    name: 'TLS status',
    method: 'GET',
    path: '/tls/status',
    channel: 'get-tls-status',
    typedPayload: typedTlsStatus,
    legacyPayload: { enabled: true, mode: 'custom' },
    expectedTyped: {
      ...typedTlsStatus,
      enabled: true,
      mode: 'self-signed',
      domain: 'gator.example',
    },
    expectedLegacy: { enabled: true, mode: 'custom' },
    call: (http, signal) => serverApi.tlsStatus(http, signal),
  },
  {
    name: 'Find My key status',
    method: 'GET',
    path: '/admin/findmy/keys/status',
    channel: 'get-findmy-keys-status',
    typedPayload: typedFindMyKeys,
    legacyPayload: { LocalStorage: { present: true, valid: true } },
    expectedTyped: typedFindMyKeys,
    expectedLegacy: { LocalStorage: { present: true, valid: true } },
    call: (http, signal) => serverApi.findMyKeysStatus(http, signal),
  },
  {
    name: 'public IP',
    method: 'GET',
    path: '/admin/network/public-ip',
    channel: 'get-public-ip',
    typedPayload: { ip: '8.8.8.8' },
    legacyPayload: { ip: '1.1.1.1' },
    expectedTyped: '8.8.8.8',
    expectedLegacy: '1.1.1.1',
    call: (http, signal) => serverApi.publicIp(http, signal),
  },
  {
    name: 'alert list',
    method: 'GET',
    path: '/alerts',
    channel: 'get-alerts',
    typedPayload: { alerts: [typedAlert] },
    legacyPayload: [typedAlert],
    expectedTyped: [typedAlert],
    expectedLegacy: [typedAlert],
    call: (http, signal) => serverApi.serverAlerts(http, signal),
  },
  {
    name: 'alert clear',
    method: 'DELETE',
    path: '/alerts',
    channel: 'clear-alerts',
    typedPayload: { removed: 1 },
    legacyPayload: { success: true },
    expectedTyped: { removed: 1 },
    expectedLegacy: { success: true },
    call: (http) => serverApi.clearServerAlerts(http),
  },
];

describe('server health prefers typed routes with narrow legacy fallback', () => {
  it.each(typedHealthRouteCases)('$name uses $method $path first', async (testCase) => {
    mockKy.mockResolvedValueOnce(envelope(testCase.typedPayload));

    await expect(testCase.call(client(), new AbortController().signal)).resolves.toEqual(
      testCase.expectedTyped,
    );
    expect(mockKy).toHaveBeenCalledTimes(1);

    const [url, init] = mockKy.mock.calls[0] as [string, { method: string }];
    expect(url).toBe(`https://x.test/api/v1${testCase.path}`);
    expect(init.method).toBe(testCase.method);
  });

  it.each(typedHealthRouteCases)(
    '$name falls back to $channel only after a typed-route 404',
    async (testCase) => {
      mockKy
        .mockResolvedValueOnce(notFound())
        .mockResolvedValueOnce(envelope(testCase.legacyPayload));

      await expect(testCase.call(client(), new AbortController().signal)).resolves.toEqual(
        testCase.expectedLegacy,
      );
      expect(mockKy).toHaveBeenCalledTimes(2);
      expect((mockKy.mock.calls[0] as [string])[0]).toBe(`https://x.test/api/v1${testCase.path}`);

      const [legacyUrl, legacyInit] = mockKy.mock.calls[1] as [
        string,
        { method: string; json: { channel: string } },
      ];
      expect(legacyUrl).toBe('https://x.test/api/v1/admin/command');
      expect(legacyInit.method).toBe('POST');
      expect(legacyInit.json.channel).toBe(testCase.channel);
    },
  );

  it('does not fall back to a legacy health channel for non-404 errors', async () => {
    mockKy.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const err = await serverApi.privateApiStatus(client()).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe('unauthorized');
    expect(mockKy).toHaveBeenCalledTimes(1);
  });

  it('accepts the strict daemon status response from GET /admin/status', async () => {
    mockKy.mockResolvedValueOnce(envelope({ version: '2.0.15', uptimeMs: 5_000 }));

    await expect(serverApi.adminStatus(client())).resolves.toEqual({
      version: '2.0.15',
      uptimeMs: 5_000,
    });
    expect(mockKy).toHaveBeenCalledTimes(1);
    const [url, init] = mockKy.mock.calls[0] as [string, { method: string }];
    expect(url).toBe('https://x.test/api/v1/admin/status');
    expect(init.method).toBe('GET');
  });
});

describe('typed health response validation', () => {
  it.each([
    {
      name: 'Private API rejects a connected Messages helper that is unavailable',
      payload: {
        ...typedPrivateApiStatus,
        available: false,
        unavailable_reason: 'trusted_helper_unavailable',
      },
      call: (http: HttpClient) => serverApi.privateApiStatus(http),
    },
    {
      name: 'Private API rejects an available FaceTime helper with an unavailable reason',
      payload: {
        ...typedPrivateApiStatus,
        ft_unavailable_reason: 'trusted_helper_unavailable',
      },
      call: (http: HttpClient) => serverApi.privateApiStatus(http),
    },
    {
      name: 'FCM rejects a partial service-account identity',
      payload: { ...typedFcmStatus, clientEmail: null },
      call: (http: HttpClient) => serverApi.fcmStatus(http),
    },
    {
      name: 'FCM rejects configured status without an account identity',
      payload: { ...typedFcmStatus, projectId: null, clientEmail: null },
      call: (http: HttpClient) => serverApi.fcmStatus(http),
    },
    {
      name: 'Find My rejects a valid key that is not present',
      payload: {
        ...typedFindMyKeys,
        FMF: { present: false, valid: true },
      },
      call: (http: HttpClient) => serverApi.findMyKeysStatus(http),
    },
    {
      name: 'public IP rejects a private address',
      payload: { ip: '192.168.1.20' },
      call: (http: HttpClient) => serverApi.publicIp(http),
    },
    {
      name: 'public IP rejects non-canonical IPv4 spelling',
      payload: { ip: '008.008.008.008' },
      call: (http: HttpClient) => serverApi.publicIp(http),
    },
    {
      name: 'TLS rejects live listener fields when it is not serving',
      payload: { ...typedTlsStatus, serving: false, restartRequired: true },
      call: (http: HttpClient) => serverApi.tlsStatus(http),
    },
    {
      name: 'TLS rejects a fallback that is not degraded',
      payload: { ...typedTlsStatus, fallback: true, degraded: false },
      call: (http: HttpClient) => serverApi.tlsStatus(http),
    },
    {
      name: 'TLS requires restart when configured and bound ports differ',
      payload: { ...typedTlsStatus, boundPort: 4321 },
      call: (http: HttpClient) => serverApi.tlsStatus(http),
    },
    {
      name: 'TLS rejects a non-canonical certificate expiry',
      payload: {
        ...typedTlsStatus,
        certificate: { ...typedTlsStatus.certificate, certExpiry: '2027-09-08' },
      },
      call: (http: HttpClient) => serverApi.tlsStatus(http),
    },
    {
      name: 'alerts reject missing required fields',
      payload: {
        alerts: [
          {
            id: 'alert-2',
            type: 'TEST',
            value: 'Missing read state',
            created: 1_700_000_000_000,
          },
        ],
      },
      call: (http: HttpClient) => serverApi.serverAlerts(http),
    },
    {
      name: 'alerts reject unbounded, malformed, and unknown fields',
      payload: {
        alerts: [
          {
            id: '',
            type: 'X'.repeat(65),
            value: 'X'.repeat(16_385),
            created: -1,
            isRead: null,
            unexpected: true,
          },
        ],
      },
      call: (http: HttpClient) => serverApi.serverAlerts(http),
    },
    {
      name: 'admin status rejects a negative uptime',
      payload: { version: '2.0.15', uptimeMs: -1 },
      call: (http: HttpClient) => serverApi.adminStatus(http),
    },
    {
      name: 'admin status rejects unknown fields',
      payload: { version: '2.0.15', uptimeMs: 5_000, unexpected: true },
      call: (http: HttpClient) => serverApi.adminStatus(http),
    },
  ])('$name without falling back to the legacy dispatcher', async ({ payload, call }) => {
    mockKy.mockResolvedValueOnce(envelope(payload));

    const err = await call(client()).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe('parse_error');
    expect(mockKy).toHaveBeenCalledTimes(1);
  });
});

describe('RCS server-owned reauthentication response validation', () => {
  it.each([
    [
      'applied',
      {
        reauthed: true,
        ok: true,
        connected: true,
        stale: false,
        message: 'Re-authenticated.',
      },
    ],
    [
      'staged',
      {
        reauthed: false,
        staged: true,
        connected: false,
        stale: true,
        message: 'Cookies staged.',
      },
    ],
  ])('accepts the %s result variant', async (_variant, payload) => {
    mockKy.mockResolvedValueOnce(envelope(payload));

    await expect(serverApi.rcsReauthNow(client())).resolves.toEqual(payload);
    expect(mockKy).toHaveBeenCalledTimes(1);
    const [url, init] = mockKy.mock.calls[0] as [string, { method: string; json: unknown }];
    expect(url).toBe('https://x.test/api/v1/rcs/reauth-now');
    expect(init).toMatchObject({ method: 'POST', json: {} });
  });

  it.each([
    ['an empty object', {}],
    [
      'an applied result carrying staged-only fields',
      {
        reauthed: true,
        ok: true,
        staged: true,
        connected: true,
        stale: false,
        message: 'Invalid mixed result.',
      },
    ],
    [
      'a staged result that claims a connection',
      {
        reauthed: false,
        staged: true,
        connected: true,
        stale: false,
        message: 'Invalid staged result.',
      },
    ],
  ])('rejects %s', async (_case, payload) => {
    mockKy.mockResolvedValueOnce(envelope(payload));

    const err = await serverApi.rcsReauthNow(client()).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe('parse_error');
    expect(mockKy).toHaveBeenCalledTimes(1);
  });
});

// A 404 on the dispatcher route means the server has no admin dispatcher at all (stock
// BlueBubbles / pre-dispatcher Gator) or a reverse proxy blocks /api/v1/admin/* (the prod Caddy
// hardening did exactly this). That must surface as UnimplementedEndpointError — "unsupported on
// this server" — never as a misleading "check your connection".
describe('admin dispatcher 404 → UnimplementedEndpointError', () => {
  it('adminCommand remaps a route-level 404', async () => {
    mockKy.mockResolvedValue(notFound());
    const err = await serverApi.adminCommand(client(), 'get-env', z.unknown()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isUnimplementedEndpoint(err)).toBe(true);
  });

  it('adminStatus remaps a route-level 404', async () => {
    mockKy.mockResolvedValue(notFound());
    const err = await serverApi.adminStatus(client()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isUnimplementedEndpoint(err)).toBe(true);
  });

  it('adminCommand propagates a non-404 unchanged (401 stays unauthorized)', async () => {
    mockKy.mockResolvedValue(new Response(null, { status: 401 }));
    const err = await serverApi.adminCommand(client(), 'get-env', z.unknown()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isUnimplementedEndpoint(err)).toBe(false);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe('unauthorized');
  });

  it('serverStatTotals: ALL channels 404 → UnimplementedEndpointError', async () => {
    mockKy.mockResolvedValue(notFound());
    const err = await serverApi.serverStatTotals(client()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isUnimplementedEndpoint(err)).toBe(true);
  });

  it('serverStatTotals: mixed 404 + network failures → the generic error, not Unimplemented', async () => {
    mockKy
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(notFound())
      .mockRejectedValue(new Error('net down'));
    const err = await serverApi.serverStatTotals(client()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isUnimplementedEndpoint(err)).toBe(false);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Server statistics unavailable');
  });
});

describe('findMy endpoints unwrap the named-key list payload', () => {
  it('getDevices returns the inner { devices } array', async () => {
    mockKy.mockResolvedValue(envelope({ devices: [{ id: 'd1' }, { id: 'd2' }] }));
    const res = await findMyApi.getDevices(client());
    expect(res).toHaveLength(2);
  });

  it('refreshDevices degrades to a GET of the device list (F-20: no /refresh route)', async () => {
    // The Gator server has no /findmy/devices/refresh — refreshDevices just GETs the list.
    mockKy.mockResolvedValue(envelope({ devices: [{ id: 'd9' }] }));
    const res = await findMyApi.refreshDevices(client());
    expect(res).toHaveLength(1);
  });
});
