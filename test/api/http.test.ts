// ky is ESM-only; mock it so the wrapper logic is testable under ts-jest/CJS.
jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));

import ky from 'ky';
import { HttpClient } from '@core/api/http';
import { ApiError } from '@core/api/errors';
import { z } from 'zod/v4';

const mockKy = ky as unknown as jest.Mock;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ status: 200, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpClient', () => {
  it('injects the password as an Authorization header, never in the query', async () => {
    mockKy.mockResolvedValue(jsonResponse({ ok: true }));
    const client = new HttpClient({
      getOrigin: () => 'https://abc.ngrok.io',
      getPassword: () => 'sekret',
    });
    await client.get('/server/info', z.object({ ok: z.boolean() }));

    const [url, options] = mockKy.mock.calls[0];
    expect(url).toBe('https://abc.ngrok.io/api/v1/server/info');
    expect(options.headers['Authorization']).toBe('Bearer sekret');
    expect(options.searchParams.has('guid')).toBe(false);
    // tunnel skip header carried over from the Flutter client
    expect(options.headers['ngrok-skip-browser-warning']).toBe('true');
  });

  it('unwraps the data envelope and validates with the schema', async () => {
    mockKy.mockResolvedValue(jsonResponse({ server_version: '1.9.5' }));
    const client = new HttpClient({ getOrigin: () => 'https://x', getPassword: () => 'p' });
    const result = await client.get('/server/info', z.object({ server_version: z.string() }));
    expect(result).toEqual({ server_version: '1.9.5' });
  });

  it('throws a parse_error ApiError on schema mismatch', async () => {
    mockKy.mockResolvedValue(jsonResponse({ wrong: 'shape' }));
    const client = new HttpClient({ getOrigin: () => 'https://x', getPassword: () => 'p' });
    await expect(
      client.get('/server/info', z.object({ server_version: z.string() })),
    ).rejects.toMatchObject({
      kind: 'parse_error',
    });
  });

  it('maps HTTP error statuses to ApiError kinds', async () => {
    mockKy.mockResolvedValue(new Response('nope', { status: 401 }));
    const client = new HttpClient({ getOrigin: () => 'https://x', getPassword: () => 'p' });
    await expect(client.get('/server/info', z.unknown())).rejects.toMatchObject({
      kind: 'unauthorized',
    });
  });

  it('builds full URLs without trailing-slash duplication', () => {
    const client = new HttpClient({ getOrigin: () => 'https://x/', getPassword: () => 'p' });
    expect(client.buildUrl('chat/query')).toBe('https://x/api/v1/chat/query');
    expect(client.buildUrl('/chat/query')).toBe('https://x/api/v1/chat/query');
  });

  it('is an ApiError instance on failure', async () => {
    mockKy.mockResolvedValue(new Response('x', { status: 500 }));
    const client = new HttpClient({ getOrigin: () => 'https://x', getPassword: () => 'p' });
    await expect(client.get('/p', z.unknown())).rejects.toBeInstanceOf(ApiError);
  });

  it('propagates one client lifetime abort through pinned requests', async () => {
    const lifetime = new AbortController();
    mockKy.mockImplementationOnce(
      async (_url: string, options: { signal: AbortSignal }): Promise<Response> =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const client = new HttpClient({
      getOrigin: () => 'https://x',
      getPassword: () => 'p',
      lifetimeSignal: lifetime.signal,
    })
      .pinTransport()
      .bindRepairSnapshot('00000000-0000-4000-8000-000000000001');

    const request = client.get('/server/info', z.unknown());
    await Promise.resolve();
    lifetime.abort(new Error('background callback expired'));

    await expect(request).rejects.toMatchObject({ kind: 'cancelled' });
    expect((mockKy.mock.calls[0]?.[1] as { signal: AbortSignal }).signal.aborted).toBe(true);
    await expect(client.get('/server/info', z.unknown())).rejects.toMatchObject({
      kind: 'cancelled',
    });
    expect(mockKy).toHaveBeenCalledTimes(1);
  });
});
