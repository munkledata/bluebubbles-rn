/**
 * Branch top-ups for HttpClient not covered by http.test.ts: the put/delete verbs, the
 * `usesHeaderAuth()` accessor, query-param serialization (skipping undefined), the
 * timeout/no-connection error mapping, the invalid-JSON parse error, and the multipart
 * upload path (success + failure) which uses raw `fetch` rather than `ky`.
 */
jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));

import ky from 'ky';
import { HttpClient } from '@core/api/http';
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

  it('maps a non-JSON body to a "parse_error"', async () => {
    mockKy.mockResolvedValue(
      new Response('<<not json>>', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const client = new HttpClient({ getOrigin: () => 'https://x', getPassword: () => 'p' });
    await expect(client.get('/p', z.unknown())).rejects.toMatchObject({ kind: 'parse_error' });
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
    const fetchImpl = jest.fn().mockRejectedValue(new Error('Network request failed'));
    const client = new HttpClient({
      getOrigin: () => 'https://x',
      getPassword: () => 'p',
      fetch: fetchImpl,
    });
    await expect(
      client.post('/attachment', okSchema, { form: new FormData() }),
    ).rejects.toMatchObject({ kind: 'no_connection' });
  });
});
