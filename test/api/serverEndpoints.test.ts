// ky is ESM-only; mock it so the endpoint wrappers are testable under ts-jest/CJS.
jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));

import ky from 'ky';
import { HttpClient } from '@core/api/http';
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

// Regression guard for the P2 envelope bug: the HttpClient already unwraps `data`, so each
// endpoint schema must describe the INNER payload — NOT re-wrap it in another { data }.
describe('server-management endpoints unwrap the { status, message, data } envelope', () => {
  it('checkUpdate reads the inner availability (not always-false)', async () => {
    mockKy.mockResolvedValue(envelope({ available: true, metadata: { version: '1.2.3' } }));
    const res = await serverApi.checkUpdate(client());
    expect(res?.available).toBe(true);
  });

  it('serverStatTotals reads the inner counts (not all dashes)', async () => {
    mockKy.mockResolvedValue(envelope({ chats: 5, messages: 99, handles: 3, attachments: 7 }));
    const res = await serverApi.serverStatTotals(client());
    expect(res?.messages).toBe(99);
    expect(res?.chats).toBe(5);
  });

  it('serverLogs returns the raw string payload (not a parse error)', async () => {
    mockKy.mockResolvedValue(envelope('line1\nline2'));
    const res = await serverApi.serverLogs(client());
    expect(res).toBe('line1\nline2');
  });

  it('restart acks tolerate a null data payload (no false error)', async () => {
    // Fresh Response per call — a Response body can only be read once.
    mockKy.mockImplementation(() => Promise.resolve(envelope(null)));
    await expect(serverApi.softRestart(client())).resolves.toBeNull();
    await expect(serverApi.restartImessage(client())).resolves.toBeNull();
  });
});

describe('findMy endpoints unwrap the named-key list payload', () => {
  it('getDevices returns the inner { devices } array', async () => {
    mockKy.mockResolvedValue(envelope({ devices: [{ id: 'd1' }, { id: 'd2' }] }));
    const res = await findMyApi.getDevices(client());
    expect(res).toHaveLength(2);
  });

  it('refreshDevices returns the refreshed { devices } array', async () => {
    mockKy.mockResolvedValue(envelope({ devices: [{ id: 'd9' }] }));
    const res = await findMyApi.refreshDevices(client());
    expect(res).toHaveLength(1);
  });
});
