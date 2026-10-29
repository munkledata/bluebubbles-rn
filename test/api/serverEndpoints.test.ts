// ky is ESM-only; mock it so the endpoint wrappers are testable under ts-jest/CJS.
jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));

/* eslint-disable import/first -- the ESM mock must be installed before these CJS test imports. */
import ky from 'ky';
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

describe('read-only iMessage account status', () => {
  const status = {
    appleId: 'person@example.test',
    displayName: 'Person',
    activeAlias: 'alias@example.test',
    aliases: ['alias@example.test'],
    vettedAliases: ['alias@example.test'],
    loginStatusMessage: null,
  };

  it('reads only the narrow authenticated status route', async () => {
    mockKy.mockResolvedValueOnce(envelope(status));
    const signal = new AbortController().signal;

    await expect(serverApi.imessageAccountStatus(client(), signal)).resolves.toEqual(status);
    expect(mockKy).toHaveBeenCalledTimes(1);
    const [url, init] = mockKy.mock.calls[0] as [string, { method: string; signal: AbortSignal }];
    expect(url).toBe('https://x.test/api/v1/imessage/account/status');
    expect(init.method).toBe('GET');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('cancels its HTTP request when the caller aborts', async () => {
    mockKy.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const controller = new AbortController();
    const pending = serverApi.imessageAccountStatus(client(), controller.signal);
    expect(mockKy).toHaveBeenCalledTimes(1);
    const requestSignal = (mockKy.mock.calls[0] as [string, { signal: AbortSignal }])[1].signal;

    controller.abort();
    expect(requestSignal.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('maps 404 without calling a retired fallback', async () => {
    mockKy.mockResolvedValueOnce(notFound());
    await expect(serverApi.imessageAccountStatus(client())).rejects.toBeInstanceOf(
      UnimplementedEndpointError,
    );
    expect(mockKy).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed account data', async () => {
    mockKy.mockResolvedValueOnce(envelope({ ...status, aliases: [{ Alias: 'bad' }] }));
    await expect(serverApi.imessageAccountStatus(client())).rejects.toThrow();
    expect(mockKy).toHaveBeenCalledTimes(1);
  });
});

describe('narrow iMessage send-from alias change', () => {
  it('POSTs one selected alias only to the separate route', async () => {
    mockKy.mockResolvedValueOnce(envelope({ activeAlias: 'alias@example.test' }));

    await expect(
      serverApi.changeImessageActiveAlias(client(), 'alias@example.test'),
    ).resolves.toEqual({ activeAlias: 'alias@example.test' });
    expect(mockKy).toHaveBeenCalledTimes(1);
    const [url, init] = mockKy.mock.calls[0] as [string, { method: string; json: unknown }];
    expect(url).toBe('https://x.test/api/v1/imessage/account/alias');
    expect(init.method).toBe('POST');
    expect(init.json).toEqual({ alias: 'alias@example.test' });
  });

  it('rejects an invalid alias before sending anything', () => {
    expect(() => serverApi.changeImessageActiveAlias(client(), 'bad\nalias')).toThrow();
    expect(mockKy).not.toHaveBeenCalled();
  });
});

describe('server-management support boundaries', () => {
  it('exports neither remote management nor the retired generic dispatcher', () => {
    expect(serverApi.SERVER_MANAGEMENT_SUPPORTED).toBe(false);
    expect(serverApi).not.toHaveProperty('restartImessage');
    expect(serverApi).not.toHaveProperty('softRestart');
    expect(serverApi).not.toHaveProperty('hardRestart');
    expect(serverApi).not.toHaveProperty('adminCommand');
    expect(serverApi).not.toHaveProperty('serverLogs');
    expect(serverApi).not.toHaveProperty('zrokStatus');
  });
});

describe('serverStatTotals uses the typed statistics route', () => {
  // The server's StatsSnapshotV1 reply, field for field.
  const allTimeSnapshot = {
    range: 'all-time',
    after: null,
    messageCount: 1234,
    chatCount: 56,
    handleCount: 78,
    attachmentCount: 90,
    imageCount: 42,
    videoCount: 7,
    locationCount: 3,
    topGroup: 'Family',
    bestFriend: '+15555550123',
  };

  it('maps all seven totals from an all-time snapshot', async () => {
    mockKy.mockResolvedValueOnce(envelope(allTimeSnapshot));

    const res = await serverApi.serverStatTotals(client());
    expect(res).toEqual({
      messages: 1234,
      chats: 56,
      handles: 78,
      attachments: 90,
      images: 42,
      videos: 7,
      locations: 3,
    });
    expect(mockKy).toHaveBeenCalledTimes(1);

    const [url, init] = mockKy.mock.calls[0] as [string, { method: string; json: unknown }];
    expect(url).toBe('https://x.test/api/v1/statistics/snapshot');
    expect(init.method).toBe('POST');
    expect(init.json).toEqual({ range: 'all-time' });
  });

  it('still refuses a snapshot with a field the server does not send', async () => {
    mockKy.mockResolvedValueOnce(envelope({ ...allTimeSnapshot, unexpectedCount: 1 }));

    const err = await serverApi.serverStatTotals(client()).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe('parse_error');
    expect(mockKy).toHaveBeenCalledTimes(1);
  });

  it('maps a typed-route 404 without trying the retired dispatcher', async () => {
    mockKy.mockResolvedValueOnce(notFound());

    const error = await serverApi.serverStatTotals(client()).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(UnimplementedEndpointError);
    expect(mockKy).toHaveBeenCalledTimes(1);
    expect((mockKy.mock.calls[0] as [string])[0]).toBe('https://x.test/api/v1/statistics/snapshot');
  });

  it('preserves a typed-route auth error without another request', async () => {
    mockKy.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const err = await serverApi.serverStatTotals(client()).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe('unauthorized');
    expect(mockKy).toHaveBeenCalledTimes(1);
  });

  it('forwards cancellation to the typed request without issuing a fallback', async () => {
    const controller = new AbortController();
    const post = jest.fn(
      async (_path: string, _schema: unknown, _options: { signal?: AbortSignal }) => {
        throw new ApiError('bad_request', 'missing typed route', 404);
      },
    );
    const http = { post } as unknown as HttpClient;

    const error = await serverApi
      .serverStatTotals(http, controller.signal)
      .catch((reason) => reason);

    expect(error).toBeInstanceOf(UnimplementedEndpointError);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[2]).toMatchObject({ signal: controller.signal });
  });
});

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
  typedPayload: unknown;
  expectedTyped: unknown;
  call: (http: HttpClient, signal: AbortSignal) => Promise<unknown>;
}

const typedHealthRouteCases: TypedHealthRouteCase[] = [
  {
    name: 'server environment',
    method: 'GET',
    path: '/server/environment',
    typedPayload: typedEnvironment,
    expectedTyped: typedEnvironment,
    call: (http, signal) => serverApi.serverEnv(http, signal),
  },
  {
    name: 'FCM status',
    method: 'GET',
    path: '/notifications/fcm/status',
    typedPayload: typedFcmStatus,
    expectedTyped: typedFcmStatus,
    call: (http, signal) => serverApi.fcmStatus(http, signal),
  },
  {
    name: 'TLS status',
    method: 'GET',
    path: '/tls/status',
    typedPayload: typedTlsStatus,
    expectedTyped: {
      ...typedTlsStatus,
      enabled: true,
      mode: 'self-signed',
      domain: 'gator.example',
    },
    call: (http, signal) => serverApi.tlsStatus(http, signal),
  },
  {
    name: 'Find My key status',
    method: 'GET',
    path: '/admin/findmy/keys/status',
    typedPayload: typedFindMyKeys,
    expectedTyped: typedFindMyKeys,
    call: (http, signal) => serverApi.findMyKeysStatus(http, signal),
  },
  {
    name: 'public IP',
    method: 'GET',
    path: '/admin/network/public-ip',
    typedPayload: { ip: '8.8.8.8' },
    expectedTyped: '8.8.8.8',
    call: (http, signal) => serverApi.publicIp(http, signal),
  },
  {
    // Shown, never trusted: the Mac decides what is public (review M144).
    name: 'public IP passes through any canonical IPv4 the server reports',
    method: 'GET',
    path: '/admin/network/public-ip',
    typedPayload: { ip: '192.168.1.20' },
    expectedTyped: '192.168.1.20',
    call: (http, signal) => serverApi.publicIp(http, signal),
  },
  {
    name: 'alert list',
    method: 'GET',
    path: '/alerts',
    typedPayload: { alerts: [typedAlert] },
    expectedTyped: [typedAlert],
    call: (http, signal) => serverApi.serverAlerts(http, signal),
  },
  {
    name: 'alert clear',
    method: 'DELETE',
    path: '/alerts',
    typedPayload: { removed: 1 },
    expectedTyped: { removed: 1 },
    call: (http) => serverApi.clearServerAlerts(http),
  },
];

describe('server health uses only typed routes', () => {
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
    '$name maps a 404 without a fallback request',
    async (testCase) => {
      mockKy.mockResolvedValueOnce(notFound());

      const error = await testCase
        .call(client(), new AbortController().signal)
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(UnimplementedEndpointError);
      expect(mockKy).toHaveBeenCalledTimes(1);
      expect((mockKy.mock.calls[0] as [string])[0]).toBe(`https://x.test/api/v1${testCase.path}`);
    },
  );

  it('preserves non-404 typed-route errors without another request', async () => {
    mockKy.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const err = await serverApi.serverEnv(client()).then(
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

  it('maps an admin-status 404 without a fallback request', async () => {
    mockKy.mockResolvedValueOnce(notFound());

    const error = await serverApi.adminStatus(client()).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(UnimplementedEndpointError);
    expect(mockKy).toHaveBeenCalledTimes(1);
    expect((mockKy.mock.calls[0] as [string])[0]).toBe('https://x.test/api/v1/admin/status');
  });
});

describe('typed health response validation', () => {
  it.each([
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
  ])('$name without issuing another request', async ({ payload, call }) => {
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
