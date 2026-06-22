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

// F-14: the Gator server implements NONE of the admin routes (they 404). The wrappers now
// reject with UnimplementedEndpointError (no doomed HTTP call) so the UI can show
// "unsupported on this server" instead of a misleading connection error.
describe('server-management endpoints are marked unimplemented (Gator 404s them)', () => {
  it('SERVER_MANAGEMENT_SUPPORTED is false', () => {
    expect(serverApi.SERVER_MANAGEMENT_SUPPORTED).toBe(false);
  });

  it.each([
    ['checkUpdate', () => serverApi.checkUpdate(client())],
    ['serverStatTotals', () => serverApi.serverStatTotals(client())],
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
