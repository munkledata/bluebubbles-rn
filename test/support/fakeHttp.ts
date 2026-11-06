import type { HttpClient, RequestOptions } from '@core/api/http';

/**
 * Hand-rolled `HttpClient` doubles shared by the API and service suites. Each shape mirrors what
 * its callers used to build inline: the resolving client exposes only `post`, the options and JSON
 * clients also answer the account-pinning helpers a service calls on its way to the network.
 */

export interface FakeHttp {
  readonly http: HttpClient;
  readonly post: jest.Mock;
}

/** A client whose `post` resolves `result` for every request. */
export function fakeHttpResolving(result: unknown): FakeHttp {
  const post = jest.fn<Promise<unknown>, [string, unknown, RequestOptions]>(async () => result);
  return { http: { post } as unknown as HttpClient, post };
}

/**
 * `impl` receives each request's options (json, signal, retry). The client also reports `origin`
 * as its pinned transport, for services that build URLs or pin before sending.
 */
export function fakeHttpPost(
  impl: (options: RequestOptions) => Promise<unknown>,
  origin = 'https://fake-http.test',
): FakeHttp {
  const post = jest.fn((_path: string, _schema: unknown, options: RequestOptions) => impl(options));
  let http!: HttpClient;
  http = {
    post,
    pinTransport: () => http,
    isTransportCurrent: () => true,
    snapshotTransport: () => ({
      origin,
      headers: {},
      password: 'test',
      transportRevision: 1,
      buildUrl: (path: string) => `${origin}/api/v1${path}`,
    }),
  } as unknown as HttpClient;
  return { http, post };
}

export interface FakeHttpJsonOptions {
  /** A `get` answer (server info, capabilities) for services that probe before posting. */
  readonly get?: () => Promise<unknown>;
}

/** `impl` receives each request's JSON body; the client also answers the account-pinning helpers. */
export function fakeHttpJson(
  impl: (json?: unknown) => Promise<unknown>,
  options: FakeHttpJsonOptions = {},
): FakeHttp {
  const post = jest.fn((_path: string, _schema: unknown, request?: { json?: unknown }) =>
    impl(request?.json),
  );
  let http!: HttpClient;
  http = {
    ...(options.get ? { get: options.get } : {}),
    post,
    pinTransport: () => http,
    isTransportCurrent: () => true,
    assertTransportCurrent: () => undefined,
  } as unknown as HttpClient;
  return { http, post };
}

/** {@link fakeHttpJson} for suites that hand the client straight to the code under test. */
export function fakeHttpJsonClient(
  impl: (json?: unknown) => Promise<unknown>,
  options?: FakeHttpJsonOptions,
): HttpClient {
  return fakeHttpJson(impl, options).http;
}
