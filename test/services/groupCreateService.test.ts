import { ApiError } from '@core/api/errors';
import type { HttpClient, RequestOptions } from '@core/api/http';
import { ServerInfo } from '@core/models';
import {
  fixedRcsCapabilitySource,
  type RcsCapabilityLease,
} from '@/services/send/rcsAttemptCapability';
import { createExactIMessageGroup } from '@/services/groupCreateService';

const GROUP_GUID = 'iMessage;+;chat-new';
const MEMBERS = ['+15557770001', '+15557770002'];
const TEMP = 'temp-group-1';

function capability(enabled = true) {
  return fixedRcsCapabilitySource(
    ServerInfo.parse({ version: 'test', supports_imessage_group_create: enabled }),
  );
}

function fakeHttp(impl: (options: RequestOptions) => Promise<unknown>): {
  http: HttpClient;
  post: jest.Mock;
} {
  const post = jest.fn((_path: string, _schema: unknown, options: RequestOptions) => impl(options));
  let http!: HttpClient;
  http = {
    post,
    pinTransport: () => http,
    isTransportCurrent: () => true,
    snapshotTransport: () => ({
      origin: 'https://create.test',
      headers: {},
      password: 'test',
      transportRevision: 1,
      buildUrl: (path: string) => `https://create.test/api/v1${path}`,
    }),
  } as unknown as HttpClient;
  return { http, post };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const ok = { guid: GROUP_GUID, messageGuid: 'msg-1', existing: false };

describe('createExactIMessageGroup', () => {
  it('sends one exact request and accepts a group acknowledgement', async () => {
    const transport = fakeHttp(async () => ok);

    await expect(
      createExactIMessageGroup(
        transport.http,
        { addresses: MEMBERS, message: 'hi all', tempGuid: TEMP },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'accepted', ...ok });
    expect(transport.post.mock.calls).toEqual([
      [
        '/chat/new-group',
        expect.anything(),
        {
          captureErrorDetail: true,
          retry: false,
          json: { addresses: MEMBERS, message: 'hi all', tempGuid: TEMP },
        },
      ],
    ]);
  });

  it.each([
    [['+15557770001'], 'one member'],
    [['+15557770001', '+15557770001'], 'a duplicate'],
    [['+15557770001', '5557770002'], 'a non-canonical number'],
    [Array.from({ length: 33 }, (_v, i) => `+1555777${String(i).padStart(4, '0')}`), '33 members'],
  ])('refuses %j (%s) before HTTP', async (addresses) => {
    const transport = fakeHttp(async () => ok);

    await expect(
      createExactIMessageGroup(
        transport.http,
        { addresses, message: 'hi', tempGuid: TEMP },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).not.toHaveBeenCalled();
  });

  it('sends members sorted whatever order they were picked in', async () => {
    const transport = fakeHttp(async () => ok);

    await createExactIMessageGroup(
      transport.http,
      { addresses: [...MEMBERS].reverse(), message: 'hi', tempGuid: TEMP },
      undefined,
      capability(),
    );
    expect(transport.post.mock.calls[0]?.[2].json.addresses).toEqual(MEMBERS);
  });

  it('refuses before HTTP without the switch, an empty message or a non-temp id', async () => {
    const transport = fakeHttp(async () => ok);
    for (const [args, source] of [
      [{ addresses: MEMBERS, message: 'hi', tempGuid: TEMP }, capability(false)],
      [{ addresses: MEMBERS, message: '   ', tempGuid: TEMP }, capability()],
      [{ addresses: MEMBERS, message: 'hi', tempGuid: 'group-1' }, capability()],
      // Everything the server would refuse before sending never reaches the network.
      [{ addresses: MEMBERS, message: 'photo \uFFFC', tempGuid: TEMP }, capability()],
      [{ addresses: MEMBERS, message: 'bell \u0007', tempGuid: TEMP }, capability()],
      [{ addresses: MEMBERS, message: 'x'.repeat(65_537), tempGuid: TEMP }, capability()],
      [
        { addresses: ['A@example.com', 'a@example.com'], message: 'hi', tempGuid: TEMP },
        capability(),
      ],
    ] as const) {
      await expect(
        createExactIMessageGroup(transport.http, args, undefined, source),
      ).resolves.toEqual({ status: 'rejected' });
    }
    expect(transport.post).not.toHaveBeenCalled();
  });

  it.each([
    ['imessage_group_create_invalid_target', 400, {}],
    ['imessage_group_create_unavailable', 503, {}],
    ['imessage_group_create_rejected', 409, {}],
    ['imessage_group_create_recipient_unavailable', 409, { notOnIMessage: true }],
    // The server's shared framework and send ledger also refuse before anything is sent.
    ['validation', 400, {}],
    ['idempotency_key_invalid', 400, {}],
    ['idempotency_capacity_exhausted', 503, {}],
    ['idempotency_persistence_unavailable', 503, {}],
  ])('returns a definite %s refusal after one attempt', async (type, status, extra) => {
    const transport = fakeHttp(async () => {
      throw ApiError.fromStatus(status, 'not created', undefined, type);
    });

    await expect(
      createExactIMessageGroup(
        transport.http,
        { addresses: MEMBERS, message: 'hi', tempGuid: TEMP },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected', ...extra });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'an explicit unknown outcome',
      ApiError.fromStatus(500, 'x', undefined, 'imessage_group_create_outcome_unknown'),
    ],
    ['an untyped 500', ApiError.fromStatus(500, 'x')],
    [
      'another command family refusal',
      ApiError.fromStatus(409, 'x', undefined, 'imessage_group_rename_rejected'),
    ],
    // The id already belongs to a different request body: that earlier attempt may have run.
    [
      'a reused idempotency key',
      ApiError.fromStatus(409, 'x', undefined, 'idempotency_key_reused'),
    ],
    [
      'the ledger’s own unknown outcome',
      ApiError.fromStatus(500, 'x', undefined, 'idempotency_outcome_unknown'),
    ],
  ])('treats %s as outcome unknown without retrying', async (_name, failure) => {
    const transport = fakeHttp(async () => {
      throw failure;
    });

    await expect(
      createExactIMessageGroup(
        transport.http,
        { addresses: MEMBERS, message: 'hi', tempGuid: TEMP },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'outcome-unknown' });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a one-to-one guid', { ...ok, guid: 'iMessage;-;+15557770001' }],
    ['a malformed acknowledgement', { guid: GROUP_GUID }],
  ])('treats %s as outcome unknown', async (_name, reply) => {
    const transport = fakeHttp(async () => reply);

    await expect(
      createExactIMessageGroup(
        transport.http,
        { addresses: MEMBERS, message: 'hi', tempGuid: TEMP },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'outcome-unknown' });
  });

  it('refuses a second creation while one is in flight', async () => {
    const response = deferred<unknown>();
    const started = deferred<void>();
    const transport = fakeHttp(async () => {
      started.resolve();
      return response.promise;
    });
    const first = createExactIMessageGroup(
      transport.http,
      { addresses: MEMBERS, message: 'hi', tempGuid: TEMP },
      undefined,
      capability(),
    );
    await started.promise;

    await expect(
      createExactIMessageGroup(
        transport.http,
        { addresses: MEMBERS, message: 'hi', tempGuid: TEMP },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    response.resolve(ok);
    await expect(first).resolves.toMatchObject({ status: 'accepted' });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('retires a late success as outcome unknown after its capability lease retires', async () => {
    const response = deferred<unknown>();
    const started = deferred<void>();
    const transport = fakeHttp(async () => {
      started.resolve();
      return response.promise;
    });
    let current = true;
    const source: RcsCapabilityLease = {
      kind: 'session',
      origin: 'https://create.test',
      revision: 1,
      serverInfo: ServerInfo.parse({ version: 'test', supports_imessage_group_create: true }),
      isCurrent: () => current,
      publish: () => false,
    };
    const result = createExactIMessageGroup(
      transport.http,
      { addresses: MEMBERS, message: 'hi', tempGuid: TEMP },
      undefined,
      source,
    );
    await started.promise;
    current = false;
    response.resolve(ok);

    await expect(result).resolves.toEqual({ status: 'outcome-unknown' });
  });

  it('keeps tab, newline and carriage return in the first message', async () => {
    const transport = fakeHttp(async () => ok);
    await expect(
      createExactIMessageGroup(
        transport.http,
        { addresses: MEMBERS, message: 'line one\r\n\tline two', tempGuid: TEMP },
        undefined,
        capability(),
      ),
    ).resolves.toMatchObject({ status: 'accepted' });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('treats emails that differ only in case as one person', async () => {
    const transport = fakeHttp(async () => ok);
    await expect(
      createExactIMessageGroup(
        transport.http,
        { addresses: ['Pat@Example.com', 'pat@example.com'], message: 'hi', tempGuid: TEMP },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).not.toHaveBeenCalled();
  });
});
