/**
 * Branch top-ups for HttpClient not covered by http.test.ts: the put/delete verbs,
 * query-param serialization (skipping undefined), the
 * timeout/no-connection error mapping, and the invalid-JSON parse error.
 */
jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));

import ky from 'ky';
import * as repairSnapshotApi from '@core/api/endpoints/repairSnapshot';
import { UnimplementedEndpointError } from '@core/api/errors';
import { HttpClient } from '@core/api/http';
import { z } from 'zod/v4';

const mockKy = ky as unknown as jest.Mock;

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ status: 200, data }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const okSchema = z.object({ ok: z.boolean() });

beforeEach(() => mockKy.mockReset());

describe('verbs + request snapshots', () => {
  it('delete routes through the request path with the right method', async () => {
    mockKy.mockImplementation(async () => jsonResponse({ ok: true }));
    const client = new HttpClient({ getOrigin: () => 'https://x', getPassword: () => 'p' });

    await client.delete('/thing', okSchema);
    expect(mockKy.mock.calls[0][1].method).toBe('DELETE');
    expect(mockKy.mock.calls[0][1].redirect).toBe('error');
  });

  it('restates redirect:error on the final fetch call after React Native Request loses it', async () => {
    const transportFetch = jest.fn(async () => jsonResponse({ ok: true }));
    mockKy.mockResolvedValue(jsonResponse({ ok: true }));
    const client = new HttpClient({
      getOrigin: () => 'https://approved.example',
      getPassword: () => 'password',
      fetch: transportFetch,
    });

    await client.post('/thing', okSchema, { json: { value: 1 } });

    const finalFetch = mockKy.mock.calls[0][1].fetch as typeof fetch;
    const requestWithoutRedirect = {
      url: 'https://approved.example/api/v1/thing',
    } as Request;
    await finalFetch(requestWithoutRedirect, { redirect: 'follow' });

    expect(transportFetch).toHaveBeenCalledWith(requestWithoutRedirect, { redirect: 'error' });
  });

  it('serializes defined query params and drops undefined ones', async () => {
    mockKy.mockResolvedValue(jsonResponse({ ok: true }));
    const client = new HttpClient({ getOrigin: () => 'https://x', getPassword: () => 'p' });
    await client.get('/q', okSchema, { query: { a: 1, b: undefined, c: 'z' } });
    const search: URLSearchParams = mockKy.mock.calls[0][1].searchParams;
    expect(search.get('a')).toBe('1');
    expect(search.get('c')).toBe('z');
    expect(search.has('b')).toBe(false);
  });

  it('captures one immutable native transport identity across live config changes', () => {
    let origin = 'https://old.example';
    let password = 'old-password';
    let customHeaders = { 'X-Account': 'old' };
    const client = new HttpClient({
      getOrigin: () => origin,
      getPassword: () => password,
      getCustomHeaders: () => customHeaders,
    });

    const transport = client.snapshotTransport();
    origin = 'https://new.example';
    password = 'new-password';
    customHeaders = { 'X-Account': 'new' };

    expect(Object.isFrozen(transport)).toBe(true);
    expect(Object.isFrozen(transport.headers)).toBe(true);
    expect(transport.origin).toBe('https://old.example');
    expect(transport.password).toBe('old-password');
    expect(transport.headers).toMatchObject({
      Authorization: 'Bearer old-password',
      'X-Account': 'old',
    });
    expect(transport.buildUrl('/binary')).toBe('https://old.example/api/v1/binary');
  });

  it('keeps native transport credentials in headers and out of URLs', () => {
    const transport = new HttpClient({
      getOrigin: () => 'https://old.example',
      getPassword: () => 'space password',
    }).snapshotTransport();

    expect(transport.headers.Authorization).toBe('Bearer space password');
    expect(transport.buildUrl('/contact/c1/avatar?size=thumb')).toBe(
      'https://old.example/api/v1/contact/c1/avatar?size=thumb',
    );
  });

  it('rejects a pinned A transport after A -> B -> A without issuing a request', async () => {
    let origin = 'https://a.example';
    let transportRevision = 1;
    const client = new HttpClient({
      getOrigin: () => origin,
      getPassword: () => 'password',
      getTransportRevision: () => transportRevision,
    });
    const pinned = client.pinTransport();

    origin = 'https://b.example';
    transportRevision += 1;
    origin = 'https://a.example';
    transportRevision += 1;

    await expect(pinned.get('/server-info', okSchema, { retry: false })).rejects.toMatchObject({
      kind: 'cancelled',
    });
    expect(mockKy).not.toHaveBeenCalled();
  });

  it('pins repair pages to one transport and owns the reserved header case-insensitively', async () => {
    let origin = 'https://repair.example';
    const token = '00000000-0000-4000-8000-000000000001';
    const client = new HttpClient({
      getOrigin: () => origin,
      getPassword: () => 'repair-password',
      getCustomHeaders: () => ({ 'X-Gator-Repair-Snapshot': 'user-value' }),
    });
    const repair = client.pinTransport().bindRepairSnapshot(token);
    mockKy.mockResolvedValue(jsonResponse({ ok: true }, 200, { 'x-gator-repair-snapshot': token }));

    await repair.get('/chat/page', okSchema, { retry: false });
    const headers = mockKy.mock.calls[0][1].headers as Record<string, string>;
    const repairHeaders = Object.entries(headers).filter(
      ([name]) => name.toLowerCase() === 'x-gator-repair-snapshot',
    );
    expect(repairHeaders).toEqual([['x-gator-repair-snapshot', token]]);
    expect(mockKy.mock.calls[0][0]).toBe('https://repair.example/api/v1/chat/page');

    mockKy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(repair.get('/chat/page', okSchema, { retry: false })).rejects.toMatchObject({
      kind: 'parse_error',
    });
    mockKy.mockResolvedValueOnce(
      jsonResponse({ ok: true }, 200, {
        'x-gator-repair-snapshot': '00000000-0000-4000-8000-000000000099',
      }),
    );
    await expect(repair.get('/chat/page', okSchema, { retry: false })).rejects.toMatchObject({
      kind: 'parse_error',
    });

    origin = 'https://rotated.example';
    await expect(repair.get('/chat/page', okSchema, { retry: false })).rejects.toMatchObject({
      kind: 'cancelled',
    });
    expect(mockKy).toHaveBeenCalledTimes(3);
  });
});

describe('repair snapshot endpoint', () => {
  const token = '00000000-0000-4000-8000-000000000021';

  it('uses the exact begin, finish, and cancel contract', async () => {
    mockKy
      .mockResolvedValueOnce(
        jsonResponse({ version: 1, action: 'begin', token, expiresAt: 1_900_000_000_000 }),
      )
      .mockResolvedValueOnce(jsonResponse({ version: 1, action: 'finish', stable: true }))
      .mockResolvedValueOnce(jsonResponse({ version: 1, action: 'cancel', cancelled: true }));
    const client = new HttpClient({
      getOrigin: () => 'https://repair.example',
      getPassword: () => 'p',
    });

    await expect(repairSnapshotApi.begin(client)).resolves.toEqual({
      token,
      expiresAt: 1_900_000_000_000,
    });
    await expect(repairSnapshotApi.finish(client, token)).resolves.toBeUndefined();
    await expect(repairSnapshotApi.cancel(client, token)).resolves.toBeUndefined();

    expect(mockKy.mock.calls.map(([url]) => url)).toEqual([
      'https://repair.example/api/v1/sync/repair-snapshot',
      'https://repair.example/api/v1/sync/repair-snapshot',
      'https://repair.example/api/v1/sync/repair-snapshot',
    ]);
    expect(mockKy.mock.calls.map(([, options]) => options.json)).toEqual([
      { action: 'begin' },
      { action: 'finish', token },
      { action: 'cancel', token },
    ]);
  });

  it('maps only begin 404 to unsupported and preserves finish conflicts', async () => {
    const client = new HttpClient({
      getOrigin: () => 'https://repair.example',
      getPassword: () => 'p',
    });
    mockKy.mockResolvedValueOnce(jsonResponse({}, 404));
    await expect(repairSnapshotApi.begin(client)).rejects.toBeInstanceOf(
      UnimplementedEndpointError,
    );

    mockKy.mockResolvedValueOnce(jsonResponse({}, 409));
    await expect(repairSnapshotApi.finish(client, token)).rejects.toMatchObject({
      kind: 'bad_request',
      status: 409,
    });
  });

  it('maps the typed RCS snapshot refusal without matching server prose', async () => {
    mockKy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 409,
          message: 'Conflict',
          error: {
            type: 'repair_snapshot_rcs_active',
            retryable: false,
            message: 'server wording may evolve independently',
          },
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new HttpClient({
      getOrigin: () => 'https://repair.example',
      getPassword: () => 'p',
    });

    await expect(repairSnapshotApi.begin(client)).rejects.toBeInstanceOf(
      repairSnapshotApi.RepairSnapshotRcsActiveError,
    );
  });

  it('rejects extra fields in the versioned success shape', async () => {
    mockKy.mockResolvedValueOnce(
      jsonResponse({
        version: 1,
        action: 'begin',
        token,
        expiresAt: 1_900_000_000_000,
        unexpected: true,
      }),
    );
    const client = new HttpClient({
      getOrigin: () => 'https://repair.example',
      getPassword: () => 'p',
    });

    await expect(repairSnapshotApi.begin(client)).rejects.toMatchObject({ kind: 'parse_error' });
  });
});

describe('error mapping', () => {
  it('maps a fetch TimeoutError to a "timeout" ApiError', async () => {
    mockKy.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const client = new HttpClient({ getOrigin: () => 'https://x', getPassword: () => 'p' });
    await expect(client.get('/p', z.unknown())).rejects.toMatchObject({ kind: 'timeout' });
  });

  it("maps ky's own TimeoutError, the error ky really throws, to a 'timeout' ApiError", async () => {
    // ky 1.x throws `class TimeoutError extends Error` (not a DOMException) when its timeout fires.
    class KyTimeoutError extends Error {
      constructor() {
        super('Request timed out: GET https://x/p');
        this.name = 'TimeoutError';
      }
    }
    mockKy.mockRejectedValue(new KyTimeoutError());
    const client = new HttpClient({ getOrigin: () => 'https://x', getPassword: () => 'p' });
    await expect(client.get('/p', z.unknown())).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('maps a generic transport failure to "no_connection"', async () => {
    mockKy.mockRejectedValue(new Error('socket hang up'));
    const client = new HttpClient({ getOrigin: () => 'https://x', getPassword: () => 'p' });
    await expect(client.get('/p', z.unknown())).rejects.toMatchObject({ kind: 'no_connection' });
  });

  it('maps an active caller abort to non-retryable cancellation', async () => {
    const controller = new AbortController();
    mockKy.mockImplementation(
      async (_url: string, options: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const client = new HttpClient({ getOrigin: () => 'https://x', getPassword: () => 'p' });
    const request = client.get('/account-read', okSchema, {
      signal: controller.signal,
      retry: { attempts: 3, baseMs: 60_000 },
    });
    await Promise.resolve();

    controller.abort('Disconnect');

    await expect(request).rejects.toMatchObject({ kind: 'cancelled' });
    expect(mockKy).toHaveBeenCalledTimes(1);
  });

  it('cancels retry backoff without starting another old-account request', async () => {
    const controller = new AbortController();
    mockKy.mockRejectedValueOnce(new Error('socket hang up'));
    const client = new HttpClient({ getOrigin: () => 'https://x', getPassword: () => 'p' });
    const request = client.get('/account-read', okSchema, {
      signal: controller.signal,
      retry: { attempts: 3, baseMs: 60_000, maxMs: 60_000, random: () => 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockKy).toHaveBeenCalledTimes(1);

    controller.abort('Disconnect');

    await expect(request).rejects.toMatchObject({ kind: 'cancelled' });
    expect(mockKy).toHaveBeenCalledTimes(1);
  });

  it('maps a non-JSON body to a "parse_error"', async () => {
    mockKy.mockResolvedValue(
      new Response('<<not json>>', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const client = new HttpClient({ getOrigin: () => 'https://x', getPassword: () => 'p' });
    await expect(client.get('/p', z.unknown())).rejects.toMatchObject({ kind: 'parse_error' });
  });
});

/**
 * Retry WIRING (http.ts:180 `wantsRetry`). `withRetry` itself is unit-tested in
 * test/core/retry.test.ts, but nothing covered which requests HttpClient actually opts in:
 * idempotent GETs retry, writes do NOT (a retried POST is the documented double-send hazard —
 * the outgoing queue owns send retries), and `retry: false` forces a single shot for the
 * reachability ping. These use REAL timers because HttpClient doesn't expose `withRetry`'s
 * injectable sleep; the default GET backoff is ≤400ms for one retry, and the opt-in write cases
 * pass `baseMs: 1`.
 */
describe('retry wiring', () => {
  const client = (): HttpClient =>
    new HttpClient({ getOrigin: () => 'https://x', getPassword: () => 'p' });

  it('retries a GET after a transient transport failure and returns the eventual success', async () => {
    mockKy
      .mockRejectedValueOnce(new Error('socket hang up')) // → ApiError('no_connection'), retryable
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(client().get('/idempotent', okSchema)).resolves.toEqual({ ok: true });
    expect(mockKy).toHaveBeenCalledTimes(2);
  });

  it('retires an old logical request after account rotation, then uses one coherent new transport', async () => {
    let origin = 'https://old.example';
    let password = 'old-password';
    let customHeader = 'old-header';
    const client = new HttpClient({
      getOrigin: () => origin,
      getPassword: () => password,
      getCustomHeaders: () => ({ 'x-account': customHeader }),
    });
    mockKy.mockImplementationOnce(async () => {
      // Deterministically model Disconnect + reconnect while the first attempt is failing.
      origin = 'https://new.example';
      password = 'new-password';
      customHeader = 'new-header';
      throw new Error('socket hang up');
    });
    mockKy.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(
      client.get('/account-bound', okSchema, {
        retry: { attempts: 2, baseMs: 0, maxMs: 0, random: () => 0 },
      }),
    ).rejects.toMatchObject({ kind: 'cancelled' });

    // The retry detects the changed snapshot before issuing any second network request.
    expect(mockKy).toHaveBeenCalledTimes(1);
    expect(mockKy.mock.calls[0]?.[0]).toBe('https://old.example/api/v1/account-bound');
    expect(mockKy.mock.calls[0]?.[1].headers).toMatchObject({
      Authorization: 'Bearer old-password',
      'x-account': 'old-header',
    });
    expect(mockKy.mock.calls[0]?.[1].searchParams.has('guid')).toBe(false);

    // A newly initiated request owns the complete new configuration; no old header, origin, or
    // password crosses the account boundary.
    await expect(client.get('/account-bound', okSchema, { retry: false })).resolves.toEqual({
      ok: true,
    });
    expect(mockKy).toHaveBeenCalledTimes(2);
    expect(mockKy.mock.calls[1]?.[0]).toBe('https://new.example/api/v1/account-bound');
    expect(mockKy.mock.calls[1]?.[1].headers.Authorization).toBe('Bearer new-password');
    expect(mockKy.mock.calls[1]?.[1].headers['x-account']).toBe('new-header');
    expect(mockKy.mock.calls[1]?.[1].searchParams.has('guid')).toBe(false);
  });

  it('does NOT retry a POST — a retried write could double-send', async () => {
    mockKy.mockRejectedValue(new Error('socket hang up'));
    await expect(
      client().post('/message/text', okSchema, { json: { a: 1 } }),
    ).rejects.toMatchObject({ kind: 'no_connection' });
    // Exactly one attempt: the same failure on a GET above produced two.
    expect(mockKy).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a DELETE either', async () => {
    mockKy.mockRejectedValue(new Error('socket hang up'));
    await expect(client().delete('/thing', okSchema)).rejects.toBeDefined();
    expect(mockKy).toHaveBeenCalledTimes(1);
  });

  it('`retry: false` forces a single shot on a GET (the fail-fast ping)', async () => {
    mockKy.mockRejectedValue(new Error('socket hang up'));
    await expect(client().get('/ping', okSchema, { retry: false })).rejects.toMatchObject({
      kind: 'no_connection',
    });
    expect(mockKy).toHaveBeenCalledTimes(1);
  });

  it('an explicit policy opts a write IN to retrying', async () => {
    mockKy
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(
      client().post('/opt-in', okSchema, {
        json: {},
        retry: { attempts: 2, baseMs: 1, random: () => 0 },
      }),
    ).resolves.toEqual({ ok: true });
    expect(mockKy).toHaveBeenCalledTimes(2);
  });

  it('does not retry a NON-transient failure on a GET (401 is not worth re-sending)', async () => {
    mockKy.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(client().get('/secure', okSchema)).rejects.toMatchObject({
      kind: 'unauthorized',
    });
    expect(mockKy).toHaveBeenCalledTimes(1);
  });
});
