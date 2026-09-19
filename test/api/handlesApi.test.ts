// ky is ESM-only; mock it so the endpoint wrapper is testable under ts-jest/CJS.
jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));

/* eslint-disable import/first -- the ESM mock must be installed before these CJS test imports. */
import ky from 'ky';
import { handlesApi } from '@core/api';
import { ApiError } from '@core/api/errors';
import { HttpClient } from '@core/api/http';
import { ServerInfo } from '@core/models';
/* eslint-enable import/first */

const mockKy = ky as unknown as jest.Mock;

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ status: 200, message: 'success', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function client(): HttpClient {
  return new HttpClient({
    getOrigin: () => 'https://gator.example',
    getPassword: () => 'server-password',
  });
}

describe('read-only iMessage availability contract', () => {
  beforeEach(() => {
    mockKy.mockReset();
  });

  it.each([true, false])(
    'preserves supports_imessage_availability=%s without restoring retired capabilities',
    (supported) => {
      const info = ServerInfo.parse({
        version: '2.0.0',
        supports_imessage_availability: supported,
        private_api: true,
        supports_imessage_text_with_attachment: true,
        supports_icloud_account: true,
      });

      expect(info.supports_imessage_availability).toBe(supported);
      expect(info.private_api).toBe(false);
      expect(info.supports_imessage_text_with_attachment).toBe(false);
      expect(info.supports_icloud_account).toBe(false);
    },
  );

  it('keeps an absent availability capability absent', () => {
    const info = ServerInfo.parse({ version: '1.9.0' });

    expect(info.supports_imessage_availability).toBeUndefined();
    expect(info.private_api).toBe(false);
    expect(info.supports_imessage_text_with_attachment).toBe(false);
    expect(info.supports_icloud_account).toBe(false);
  });

  it.each([true, false])(
    'uses one authenticated POST body and returns available=%s',
    async (available) => {
      mockKy.mockResolvedValueOnce(envelope({ available }));

      await expect(handlesApi.checkIMessageAvailability(client(), '+15551234567')).resolves.toBe(
        available,
      );

      expect(mockKy).toHaveBeenCalledTimes(1);
      const [url, options] = mockKy.mock.calls[0] as [
        string,
        {
          method: string;
          headers: Record<string, string>;
          json?: unknown;
          searchParams?: URLSearchParams;
        },
      ];
      expect(url).toBe('https://gator.example/api/v1/handle/availability/imessage');
      expect(options.method).toBe('POST');
      expect(options.headers.Authorization).toBe('Bearer server-password');
      expect(options.json).toEqual({ address: '+15551234567' });
      expect(options.searchParams?.toString()).toBe('');
    },
  );

  it.each([{ available: 'true' }, { available: true, unexpected: 'not allowed' }])(
    'rejects a response outside the strict { available: boolean } contract',
    async (payload) => {
      mockKy.mockResolvedValueOnce(envelope(payload));

      await expect(
        handlesApi.checkIMessageAvailability(client(), 'person@example.com'),
      ).rejects.toMatchObject({ kind: 'parse_error' });
      expect(mockKy).toHaveBeenCalledTimes(1);
    },
  );

  it('propagates an authentication failure without a fallback request', async () => {
    mockKy.mockResolvedValueOnce(new Response(null, { status: 401 }));

    const error = await handlesApi
      .checkIMessageAvailability(client(), 'person@example.com')
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('unauthorized');
    expect(mockKy).toHaveBeenCalledTimes(1);
  });

  it('opts into the reviewed typed-unavailable error without adding another request path', async () => {
    const unavailable = new ApiError(
      'server_error',
      'POST /handle/availability/imessage failed',
      503,
      undefined,
      'iMessage availability lookup is temporarily unavailable',
      'imessage_availability_unavailable',
    );
    const post = jest.fn().mockRejectedValue(unavailable);

    await expect(
      handlesApi.checkIMessageAvailability({ post } as unknown as HttpClient, 'person@example.com'),
    ).rejects.toBe(unavailable);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[2]).toMatchObject({ captureErrorDetail: true });
  });
});
