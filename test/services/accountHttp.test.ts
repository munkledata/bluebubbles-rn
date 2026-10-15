/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
// ky is ESM-only; mock it so the real HttpClient runs under ts-jest/CJS.
jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@native/secureVault', () => ({ ExpoSecureVault: class {} }));
jest.mock('@native/accountRevocationMarker', () => ({ ExpoAccountRevocationMarker: class {} }));
jest.mock('@native/dbWriteWedgeMarker', () => ({ ExpoDbWriteWedgeMarker: class {} }));
jest.mock('@state/sessionStore', () => ({
  sessionAccessors: {
    getOrigin: () => 'https://mac.example',
    getPassword: () => 'secret',
    getTransportRevision: () => 1,
  },
}));

import ky from 'ky';
import { z } from 'zod/v4';
import { accountHttp, http } from '@/services/clients';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
  runTrackedRealtimeWork,
} from '@/services/realtime/deliveryCoordinator';

const mockKy = ky as unknown as jest.Mock;

// Settles anyway after a few seconds, so a broken cancellation fails this test by timing instead of
// leaving a drain slot that would hang every later test in the file.
function hangUntilAborted(_url: string, options: { signal: AbortSignal }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const fallback = setTimeout(() => resolve(jsonResponse({ late: true })), 3_000);
    options.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(fallback);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ status: 200, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// Review item 1073: a chat action held its Disconnect drain slot across a request nothing could
// cancel (up to the 30 s timeout) while Disconnect waits only 5 s, so Disconnect failed with
// "could not safely finish clearing the previous connection".
describe('account requests and Disconnect', () => {
  afterEach(() => {
    resumeRealtimeDeliveries();
    mockKy.mockReset();
  });

  it('cancels a hanging account request as soon as Disconnect starts', async () => {
    mockKy.mockImplementation(hangUntilAborted);
    const lease = captureRealtimeDeliveryLease();
    let failure: unknown;
    const action = runTrackedRealtimeWork(lease, async (active) => {
      try {
        await accountHttp(active).post('/chat/a/read', z.unknown(), { retry: false });
      } catch (error) {
        failure = error;
      }
    });
    for (let turn = 0; turn < 20 && mockKy.mock.calls.length === 0; turn += 1) {
      await Promise.resolve();
    }
    expect(mockKy).toHaveBeenCalledTimes(1);

    // Without cancellation this drain would wait for the request's timeout.
    const pauseStarted = Date.now();
    await pauseRealtimeDeliveries();
    expect(Date.now() - pauseStarted).toBeLessThan(1_000);
    await expect(action).resolves.toBe('delivered');
    expect(failure).toMatchObject({ kind: 'cancelled' });
  });

  it('leaves the shared client working for Disconnect’s own requests', async () => {
    const lease = captureRealtimeDeliveryLease();
    await pauseRealtimeDeliveries();

    mockKy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(http.get('/server/info', z.unknown())).resolves.toEqual({ ok: true });
    await expect(accountHttp(lease).get('/server/info', z.unknown())).rejects.toMatchObject({
      kind: 'cancelled',
    });
    expect(mockKy).toHaveBeenCalledTimes(1);
  });
});
