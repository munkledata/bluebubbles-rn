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

  it('falls back to legacy ?guid= only when header auth is disabled', async () => {
    mockKy.mockResolvedValue(jsonResponse({ ok: true }));
    const onLegacyAuth = jest.fn();
    const client = new HttpClient({
      getOrigin: () => 'https://abc.ngrok.io',
      getPassword: () => 'sekret',
      useHeaderAuth: () => false,
      onLegacyAuth,
    });
    await client.get('/server/info', z.object({ ok: z.boolean() }));

    const [, options] = mockKy.mock.calls[0];
    expect(options.headers['Authorization']).toBeUndefined();
    expect(options.searchParams.get('guid')).toBe('sekret');
    expect(onLegacyAuth).toHaveBeenCalledTimes(1);
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
});
