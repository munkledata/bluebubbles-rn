import { getAccountInfo } from '@core/api/endpoints/icloud';
import { ApiError, UnimplementedEndpointError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';

/** A minimal fake HttpClient whose `get` runs the provided impl. */
function mkHttp(impl: () => Promise<unknown>): HttpClient {
  return { get: jest.fn(impl) } as unknown as HttpClient;
}

describe('getAccountInfo', () => {
  it('returns the parsed account on success', async () => {
    const http = mkHttp(async () => ({ appleId: 'me@icloud.com', aliases: ['me@icloud.com'] }));
    await expect(getAccountInfo(http)).resolves.toMatchObject({ appleId: 'me@icloud.com' });
  });

  it('remaps a 404 (route not implemented on the server) to UnimplementedEndpointError', async () => {
    const http = mkHttp(async () => {
      throw ApiError.fromStatus(404);
    });
    await expect(getAccountInfo(http)).rejects.toBeInstanceOf(UnimplementedEndpointError);
  });

  it('passes a real error (e.g. 401 unauthorized) straight through', async () => {
    const http = mkHttp(async () => {
      throw ApiError.fromStatus(401);
    });
    await expect(getAccountInfo(http)).rejects.toBeInstanceOf(ApiError);
  });

  it('forwards the query cancellation signal to HttpClient', async () => {
    const http = mkHttp(async () => ({ appleId: 'me@icloud.com', aliases: [] }));
    const controller = new AbortController();

    await getAccountInfo(http, controller.signal);

    expect(http.get).toHaveBeenCalledWith('/icloud/account', expect.anything(), {
      signal: controller.signal,
    });
  });
});
