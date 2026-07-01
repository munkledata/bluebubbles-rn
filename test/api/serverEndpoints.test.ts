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

// Restart / logs / update-check are only on the server's LOCAL admin console (reinject-helper
// etc. are 403 for a remote client), so the wrappers reject with UnimplementedEndpointError (no
// doomed HTTP call) and the UI hides them. Statistics ARE served on the password path and are
// tested separately below.
describe('server-management console-only endpoints stay unimplemented', () => {
  it('SERVER_MANAGEMENT_SUPPORTED is false', () => {
    expect(serverApi.SERVER_MANAGEMENT_SUPPORTED).toBe(false);
  });

  it.each([
    ['checkUpdate', () => serverApi.checkUpdate(client())],
    ['serverLogs', () => serverApi.serverLogs(client())],
    ['softRestart', () => serverApi.softRestart(client())],
    ['hardRestart', () => serverApi.hardRestart(client())],
    ['restartImessage', () => serverApi.restartImessage(client())],
  ])('%s rejects with UnimplementedEndpointError (no HTTP call)', async (_name, call) => {
    const err = await call().then(
      () => null,
      (e: unknown) => e,
    );
    expect(isUnimplementedEndpoint(err)).toBe(true);
    expect(mockKy).not.toHaveBeenCalled();
  });
});

describe('serverStatTotals reads stats via the admin-command dispatcher', () => {
  it('aggregates message + image + video counts', async () => {
    // Promise.all fires the 3 channels in order: message-count, image-count, video-count.
    mockKy
      .mockResolvedValueOnce(envelope(1234)) // get-message-count → a plain number
      .mockResolvedValueOnce(envelope([{ media_count: 42 }])) // get-chat-image-count
      .mockResolvedValueOnce(envelope([{ media_count: 7 }])); // get-chat-video-count
    const res = await serverApi.serverStatTotals(client());
    expect(res).toEqual({ messages: 1234, images: 42, videos: 7 });
    expect(mockKy).toHaveBeenCalledTimes(3);
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
