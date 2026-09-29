import { ApiError } from '@core/api/errors';
import type { HttpClient, RequestOptions } from '@core/api/http';
import { ServerInfo, serverSendCapabilityKey } from '@core/models';
import { createExactFaceTimeLink } from '@/services/facetimeLinkService';
import {
  fixedRcsCapabilitySource,
  type RcsCapabilityLease,
} from '@/services/send/rcsAttemptCapability';

const FACE_TIME_LINK = `https://facetime.apple.com/join#v=1&p=${'A'.repeat(22)}&k=${'A'.repeat(43)}`;

function capability(enabled = true) {
  return fixedRcsCapabilitySource(
    ServerInfo.parse({ version: 'test', supports_facetime_link_creation: enabled }),
  );
}

function fakeHttp(impl: (options: RequestOptions) => Promise<unknown>): {
  http: HttpClient;
  post: jest.Mock;
  pinTransport: jest.Mock;
} {
  const post = jest.fn((_path: string, _schema: unknown, options: RequestOptions) => impl(options));
  let http!: HttpClient;
  const pinTransport = jest.fn(() => http);
  http = {
    post,
    pinTransport,
    isTransportCurrent: () => true,
    snapshotTransport: () => ({
      origin: 'https://facetime-link.test',
      headers: { Authorization: 'Bearer test-only' },
      password: 'test-only',
      transportRevision: 7,
      buildUrl: (path: string) => `https://facetime-link.test/api/v1${path}`,
    }),
  } as unknown as HttpClient;
  return { http, post, pinTransport };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('createExactFaceTimeLink', () => {
  it('pins before dispatch, creates once, and returns only the accepted bearer link', async () => {
    const transport = fakeHttp(async () => ({ link: FACE_TIME_LINK }));

    await expect(createExactFaceTimeLink(transport.http, undefined, capability())).resolves.toEqual(
      { status: 'accepted', link: FACE_TIME_LINK },
    );
    expect(transport.pinTransport).toHaveBeenCalledTimes(1);
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post.mock.calls[0]?.[2]).toMatchObject({
      retry: false,
      json: { tempGuid: expect.stringMatching(/^temp-[a-z0-9]{8}$/) },
    });
  });

  it('publishes the capability in the mutation revision and refuses a missing capability', async () => {
    const enabled = ServerInfo.parse({ version: 'test', supports_facetime_link_creation: true });
    const disabled = ServerInfo.parse({ version: 'test', supports_facetime_link_creation: false });
    expect(serverSendCapabilityKey(enabled)).not.toBe(serverSendCapabilityKey(disabled));

    const transport = fakeHttp(async () => ({ link: FACE_TIME_LINK }));
    await expect(
      createExactFaceTimeLink(transport.http, undefined, capability(false)),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).not.toHaveBeenCalled();
  });

  it('rejects capability proof from a different origin/revision before HTTP', async () => {
    const transport = fakeHttp(async () => ({ link: FACE_TIME_LINK }));
    const wrongOwner: RcsCapabilityLease = {
      kind: 'session',
      origin: 'https://other-account.test',
      revision: 99,
      serverInfo: ServerInfo.parse({ version: 'test', supports_facetime_link_creation: true }),
      isCurrent: () => true,
      publish: () => false,
    };

    await expect(createExactFaceTimeLink(transport.http, undefined, wrongOwner)).resolves.toEqual({
      status: 'rejected',
    });
    expect(transport.post).not.toHaveBeenCalled();
  });

  it('allows only one active attempt and releases the lane when that attempt settles', async () => {
    const response = deferred<unknown>();
    const started = deferred<void>();
    const transport = fakeHttp(async () => {
      started.resolve();
      return response.promise;
    });
    const first = createExactFaceTimeLink(transport.http, undefined, capability());
    await started.promise;

    await expect(createExactFaceTimeLink(transport.http, undefined, capability())).resolves.toEqual(
      { status: 'rejected' },
    );
    expect(transport.post).toHaveBeenCalledTimes(1);

    response.resolve({ link: FACE_TIME_LINK });
    await expect(first).resolves.toEqual({ status: 'accepted', link: FACE_TIME_LINK });
    await expect(createExactFaceTimeLink(transport.http, undefined, capability())).resolves.toEqual(
      { status: 'accepted', link: FACE_TIME_LINK },
    );
    expect(transport.post).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['facetime_link_invalid', 400],
    ['facetime_link_unavailable', 503],
    ['facetime_link_rejected', 409],
    ['idempotency_key_invalid', 400],
    ['idempotency_capacity_exhausted', 503],
    ['idempotency_persistence_unavailable', 503],
  ] as const)(
    'keeps exact %s/%i definite without an automatic retry',
    async (serverErrorType, status) => {
      const transport = fakeHttp(async () => {
        throw ApiError.fromStatus(status, 'definite refusal', undefined, serverErrorType);
      });

      await expect(
        createExactFaceTimeLink(transport.http, undefined, capability()),
      ).resolves.toEqual({ status: 'rejected' });
      expect(transport.post).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['facetime_link_outcome_unknown', 409],
    ['idempotency_key_reused', 409],
    ['idempotency_outcome_unknown', 409],
    ['facetime_link_unavailable', 409],
  ] as const)(
    'keeps uncertain or unreviewed %s/%i outcome-unknown without replay',
    async (serverErrorType, status) => {
      const transport = fakeHttp(async () => {
        throw ApiError.fromStatus(status, 'uncertain result', undefined, serverErrorType);
      });

      await expect(
        createExactFaceTimeLink(transport.http, undefined, capability()),
      ).resolves.toEqual({ status: 'outcome-unknown' });
      expect(transport.post).toHaveBeenCalledTimes(1);
    },
  );

  it('does not expose or reuse an ambiguous attempt identity', async () => {
    const random = jest
      .spyOn(Math, 'random')
      .mockReturnValueOnce(0.123456789)
      .mockReturnValueOnce(0.987654321);
    const transport = fakeHttp(async () => {
      throw new ApiError('no_connection', 'response missing');
    });

    const first = await createExactFaceTimeLink(transport.http, undefined, capability());
    const second = await createExactFaceTimeLink(transport.http, undefined, capability());
    expect(first).toEqual({ status: 'outcome-unknown' });
    expect(second).toEqual({ status: 'outcome-unknown' });
    const firstGuid = (transport.post.mock.calls[0]?.[2].json as { tempGuid: string }).tempGuid;
    const secondGuid = (transport.post.mock.calls[1]?.[2].json as { tempGuid: string }).tempGuid;
    expect(secondGuid).not.toBe(firstGuid);
    expect(transport.post).toHaveBeenCalledTimes(2);
    random.mockRestore();
  });

  it('suppresses a late accepted link when its exact capability owner retires', async () => {
    const response = deferred<unknown>();
    const started = deferred<void>();
    const transport = fakeHttp(async () => {
      started.resolve();
      return response.promise;
    });
    let current = true;
    const source: RcsCapabilityLease = {
      kind: 'session',
      origin: 'https://facetime-link.test',
      revision: 7,
      serverInfo: ServerInfo.parse({ version: 'test', supports_facetime_link_creation: true }),
      isCurrent: () => current,
      publish: () => false,
    };
    const result = createExactFaceTimeLink(transport.http, undefined, source);
    await started.promise;
    current = false;
    response.resolve({ link: FACE_TIME_LINK });

    await expect(result).resolves.toEqual({ status: 'outcome-unknown' });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });
});
