// ky is ESM-only; mock it so the endpoint wrappers are testable under ts-jest/CJS.
jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));

import ky from 'ky';
import { HttpClient } from '@core/api/http';
import { isUnimplementedEndpoint } from '@core/api/errors';
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

  it.each([
    ['restartImessage', () => serverApi.restartImessage(client())],
    ['softRestart', () => serverApi.softRestart(client())],
    ['hardRestart', () => serverApi.hardRestart(client())],
  ])('%s posts once to the dispatcher and resolves', async (_name, call) => {
    mockKy.mockResolvedValueOnce(envelope({ success: true }));
    await expect(call()).resolves.toBeDefined();
    expect(mockKy).toHaveBeenCalledTimes(1);
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
