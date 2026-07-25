// ky is ESM-only; mock it so the endpoint wrappers are testable under ts-jest/CJS.
jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));

import ky from 'ky';
import { z } from 'zod/v4';
import { HttpClient } from '@core/api/http';
import { ApiError, isUnimplementedEndpoint } from '@core/api/errors';
import * as serverApi from '@core/api/endpoints/server';
import * as findMyApi from '@core/api/endpoints/findmy';

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

// Restart (iMessage / services / server) and log-fetch are wired to the password-authed
// admin-command dispatcher, so their wrappers POST to /admin/command and the UI shows them.
// Update-check has no equivalent on the Gator fork, so it stays a no-HTTP rejection.
describe('server-management restart/logs go through the admin-command dispatcher', () => {
  it('SERVER_MANAGEMENT_SUPPORTED is true', () => {
    expect(serverApi.SERVER_MANAGEMENT_SUPPORTED).toBe(true);
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

describe('serverStatTotals reads stats via the admin-command dispatcher', () => {
  it('aggregates message/chat/handle counts + attachment/image/video/location media counts', async () => {
    // Promise.all order: message, chat, handle (plain numbers), then attachment, image, video,
    // location ([{ media_count }]).
    mockKy
      .mockResolvedValueOnce(envelope(1234)) // get-message-count
      .mockResolvedValueOnce(envelope(56)) // get-chat-count
      .mockResolvedValueOnce(envelope(78)) // get-handle-count
      .mockResolvedValueOnce(envelope([{ media_count: 90 }])) // get-chat-attachment-count
      .mockResolvedValueOnce(envelope([{ media_count: 42 }])) // get-chat-image-count
      .mockResolvedValueOnce(envelope([{ media_count: 7 }])) // get-chat-video-count
      .mockResolvedValueOnce(envelope([{ media_count: 3 }])); // get-chat-location-count
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
    expect(mockKy).toHaveBeenCalledTimes(7);
  });

  it('degrades to PARTIAL totals when some channels fail — a single failure no longer blanks all', async () => {
    // message OK, chat fails, handle OK, attachment fails, image OK, video fails, location fails.
    mockKy
      .mockResolvedValueOnce(envelope(1234))
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(envelope(78))
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(envelope([{ media_count: 42 }]))
      .mockRejectedValueOnce(new Error('nope'))
      .mockRejectedValueOnce(new Error('nope'));
    const res = await serverApi.serverStatTotals(client());
    expect(res).toEqual({
      messages: 1234,
      chats: 0, // failed → 0, not a rejected Promise.all that blanks everything
      handles: 78,
      attachments: 0,
      images: 42,
      videos: 0,
      locations: 0,
    });
  });

  it('throws when EVERY channel fails, so the UI can show "unavailable" not all-zeros', async () => {
    mockKy.mockRejectedValue(new Error('server down'));
    await expect(serverApi.serverStatTotals(client())).rejects.toThrow();
  });
});

// A 404 on the dispatcher route means the server has no admin dispatcher at all (stock
// BlueBubbles / pre-dispatcher Gator) or a reverse proxy blocks /api/v1/admin/* (the prod Caddy
// hardening did exactly this). That must surface as UnimplementedEndpointError — "unsupported on
// this server" — never as a misleading "check your connection".
describe('admin dispatcher 404 → UnimplementedEndpointError', () => {
  const notFound = (): Response => new Response(null, { status: 404 }); // empty body, like a proxy

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
    mockKy.mockResolvedValueOnce(notFound()).mockRejectedValue(new Error('net down'));
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
