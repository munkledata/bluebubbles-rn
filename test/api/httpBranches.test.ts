/**
 * Branch top-ups for HttpClient not covered by http.test.ts: the put/delete verbs, the
 * `usesHeaderAuth()` accessor, query-param serialization (skipping undefined), the
 * timeout/no-connection error mapping, the invalid-JSON parse error, and the multipart
 * upload path (success + failure) which uses raw `fetch` rather than `ky`.
 */
jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));

import ky from 'ky';
import { HttpClient } from '@core/api/http';
import { logger } from '@core/secure';
import { z } from 'zod/v4';

const mockKy = ky as unknown as jest.Mock;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ status: 200, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const okSchema = z.object({ ok: z.boolean() });

beforeEach(() => mockKy.mockReset());

describe('verbs + accessors', () => {
  it('put and delete route through the request path with the right method', async () => {
    // Fresh Response per call — a Response body can only be read once.
    mockKy.mockImplementation(async () => jsonResponse({ ok: true }));
    const client = new HttpClient({ getOrigin: () => 'https://x', getPassword: () => 'p' });

    await client.put('/thing', okSchema, { json: { a: 1 } });
    expect(mockKy.mock.calls[0][1].method).toBe('PUT');

    await client.delete('/thing', okSchema);
    expect(mockKy.mock.calls[1][1].method).toBe('DELETE');
  });

  it('usesHeaderAuth() reflects the injected config (default true, false when disabled)', () => {
    expect(new HttpClient({ getOrigin: () => 'x', getPassword: () => 'p' }).usesHeaderAuth()).toBe(
      true,
    );
    expect(
      new HttpClient({
        getOrigin: () => 'x',
        getPassword: () => 'p',
        useHeaderAuth: () => false,
      }).usesHeaderAuth(),
    ).toBe(false);
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
    let headerAuth = true;
    let customHeaders = { 'X-Account': 'old' };
    const client = new HttpClient({
      getOrigin: () => origin,
      getPassword: () => password,
      useHeaderAuth: () => headerAuth,
      getCustomHeaders: () => customHeaders,
    });

    const transport = client.snapshotTransport();
    origin = 'https://new.example';
    password = 'new-password';
    headerAuth = false;
    customHeaders = { 'X-Account': 'new' };

    expect(Object.isFrozen(transport)).toBe(true);
    expect(Object.isFrozen(transport.headers)).toBe(true);
    expect(transport.origin).toBe('https://old.example');
    expect(transport.authMode).toBe('header');
    expect(transport.password).toBe('old-password');
    expect(transport.headers).toMatchObject({
      Authorization: 'Bearer old-password',
      'X-Account': 'old',
    });
    expect(transport.buildUrl('/binary')).toBe('https://old.example/api/v1/binary');
  });

  it('centralizes explicit legacy auth in native transport URLs', () => {
    const onLegacyAuth = jest.fn();
    const transport = new HttpClient({
      getOrigin: () => 'https://old.example',
      getPassword: () => 'space password',
      useHeaderAuth: () => false,
      onLegacyAuth,
    }).snapshotTransport();

    expect(transport.headers.Authorization).toBeUndefined();
    expect(transport.buildUrl('/contact/c1/avatar?size=thumb')).toBe(
      'https://old.example/api/v1/contact/c1/avatar?size=thumb&guid=space+password',
    );
    expect(onLegacyAuth).toHaveBeenCalledTimes(1);
  });
});

describe('error mapping', () => {
  it('maps a fetch TimeoutError to a "timeout" ApiError', async () => {
    mockKy.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
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
    let headerAuth = true;
    let customHeader = 'old-header';
    const client = new HttpClient({
      getOrigin: () => origin,
      getPassword: () => password,
      useHeaderAuth: () => headerAuth,
      getCustomHeaders: () => ({ 'x-account': customHeader }),
    });
    mockKy.mockImplementationOnce(async () => {
      // Deterministically model Disconnect + reconnect while the first attempt is failing.
      origin = 'https://new.example';
      password = 'new-password';
      headerAuth = false;
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

    // A newly initiated request owns the complete new legacy-query configuration; no old header,
    // origin, or password crosses the account boundary.
    await expect(client.get('/account-bound', okSchema, { retry: false })).resolves.toEqual({
      ok: true,
    });
    expect(mockKy).toHaveBeenCalledTimes(2);
    expect(mockKy.mock.calls[1]?.[0]).toBe('https://new.example/api/v1/account-bound');
    expect(mockKy.mock.calls[1]?.[1].headers.Authorization).toBeUndefined();
    expect(mockKy.mock.calls[1]?.[1].headers['x-account']).toBe('new-header');
    expect(mockKy.mock.calls[1]?.[1].searchParams.get('guid')).toBe('new-password');
  });

  it('does NOT retry a POST — a retried write could double-send', async () => {
    mockKy.mockRejectedValue(new Error('socket hang up'));
    await expect(
      client().post('/message/text', okSchema, { json: { a: 1 } }),
    ).rejects.toMatchObject({ kind: 'no_connection' });
    // Exactly one attempt: the same failure on a GET above produced two.
    expect(mockKy).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a PUT or DELETE either', async () => {
    mockKy.mockRejectedValue(new Error('socket hang up'));
    await expect(client().put('/thing', okSchema, { json: {} })).rejects.toBeDefined();
    expect(mockKy).toHaveBeenCalledTimes(1);
    await expect(client().delete('/thing', okSchema)).rejects.toBeDefined();
    expect(mockKy).toHaveBeenCalledTimes(2);
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

describe('multipart upload (raw fetch path)', () => {
  it('uploads via the injected fetch, carrying auth headers and the form body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = new HttpClient({
      getOrigin: () => 'https://x',
      getPassword: () => 'sekret',
      fetch: fetchImpl,
    });
    const form = new FormData();
    const res = await client.post('/attachment', okSchema, { form });
    expect(res).toEqual({ ok: true });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://x/api/v1/attachment');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(form);
    expect(init.headers['Authorization']).toBe('Bearer sekret');
    // Never routed through ky.
    expect(mockKy).not.toHaveBeenCalled();
  });

  it('maps a failed upload to a "no_connection" ApiError', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const fetchImpl = jest.fn().mockRejectedValue(new Error('Network request failed'));
    const client = new HttpClient({
      getOrigin: () => 'https://x',
      getPassword: () => 'p',
      fetch: fetchImpl,
    });
    await expect(
      client.post('/attachment', okSchema, { form: new FormData() }),
    ).rejects.toMatchObject({ kind: 'no_connection' });
    expect(warn).toHaveBeenCalledWith(
      '[http] multipart upload failed url=https://x/api/v1/attachment err=Error: Network request failed',
    );
    warn.mockRestore();
  });
});
