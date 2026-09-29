import { ApiError } from '@core/api/errors';
import type { HttpClient, RequestOptions } from '@core/api/http';
import { ServerInfo, serverSendCapabilityKey } from '@core/models';
import {
  answerExactFaceTimeCall,
  leaveExactFaceTimeCall,
  startExactFaceTimeCall,
} from '@/services/facetimeCallService';
import { createExactFaceTimeLink } from '@/services/facetimeLinkService';
import {
  fixedRcsCapabilitySource,
  type RcsCapabilityLease,
} from '@/services/send/rcsAttemptCapability';

const ADDRESS = 'alice@example.com';
const CALL_UUID = '01234567-89ab-cdef-0123-456789abcdef';
const FACE_TIME_LINK = `https://facetime.apple.com/join#v=1&p=${'A'.repeat(22)}&k=${'A'.repeat(43)}`;

function capability(callEnabled = true, linkEnabled = false) {
  return fixedRcsCapabilitySource(
    ServerInfo.parse({
      version: 'test',
      supports_facetime_call_start: callEnabled,
      supports_facetime_link_creation: linkEnabled,
    }),
  );
}

function controlCapability(answerEnabled = true, leaveEnabled = true, linkEnabled = false) {
  return fixedRcsCapabilitySource(
    ServerInfo.parse({
      version: 'test',
      supports_facetime_call_answer: answerEnabled,
      supports_facetime_call_leave: leaveEnabled,
      supports_facetime_link_creation: linkEnabled,
    }),
  );
}

function controlCall(
  action: 'answer' | 'leave',
  http: HttpClient,
  source: ReturnType<typeof controlCapability>,
) {
  return action === 'answer'
    ? answerExactFaceTimeCall(http, { callUuid: CALL_UUID }, undefined, source)
    : leaveExactFaceTimeCall(http, { callUuid: CALL_UUID }, undefined, source);
}

function fakeHttp(
  impl: (options: RequestOptions) => Promise<unknown>,
  origin = 'https://facetime-call.test',
): {
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
      origin,
      headers: { Authorization: 'Bearer test-only' },
      password: 'test-only',
      transportRevision: 7,
      buildUrl: (path: string) => `${origin}/api/v1${path}`,
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

describe('startExactFaceTimeCall', () => {
  it('pins before one exact dispatch and preserves the submitted address and Boolean', async () => {
    const transport = fakeHttp(async () => ({ started: true }));

    await expect(
      startExactFaceTimeCall(
        transport.http,
        { address: ADDRESS, video: false },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'accepted' });
    expect(transport.pinTransport).toHaveBeenCalledTimes(1);
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post.mock.calls[0]?.[2]).toMatchObject({
      retry: false,
      json: {
        address: ADDRESS,
        video: false,
        tempGuid: expect.stringMatching(/^temp-[a-z0-9]{8}$/),
      },
    });
  });

  it('publishes the call flag in the mutation revision and fails closed without it', async () => {
    const enabled = ServerInfo.parse({ version: 'test', supports_facetime_call_start: true });
    const disabled = ServerInfo.parse({ version: 'test', supports_facetime_call_start: false });
    expect(serverSendCapabilityKey(enabled)).not.toBe(serverSendCapabilityKey(disabled));

    const transport = fakeHttp(async () => ({ started: true }));
    await expect(
      startExactFaceTimeCall(
        transport.http,
        { address: ADDRESS, video: true },
        undefined,
        capability(false),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).not.toHaveBeenCalled();
  });

  it('rejects invalid input or capability proof from another origin/revision before HTTP', async () => {
    const transport = fakeHttp(async () => ({ started: true }));

    await expect(
      startExactFaceTimeCall(
        transport.http,
        { address: 'Alice@example.com', video: true },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    await expect(
      startExactFaceTimeCall(
        transport.http,
        { address: ADDRESS, video: 'true' as unknown as boolean },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.pinTransport).not.toHaveBeenCalled();

    const wrongOwner: RcsCapabilityLease = {
      kind: 'session',
      origin: 'https://other-account.test',
      revision: 99,
      serverInfo: ServerInfo.parse({ version: 'test', supports_facetime_call_start: true }),
      isCurrent: () => true,
      publish: () => false,
    };
    await expect(
      startExactFaceTimeCall(
        transport.http,
        { address: ADDRESS, video: true },
        undefined,
        wrongOwner,
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).not.toHaveBeenCalled();
  });

  it('shares one global non-queuing mutation lane with FaceTime link creation', async () => {
    const response = deferred<unknown>();
    const linkStarted = deferred<void>();
    const linkTransport = fakeHttp(async () => {
      linkStarted.resolve();
      return response.promise;
    });
    const callTransport = fakeHttp(async () => ({ started: true }));
    const sharedCapability = capability(true, true);

    const link = createExactFaceTimeLink(linkTransport.http, undefined, sharedCapability);
    await linkStarted.promise;
    await expect(
      startExactFaceTimeCall(
        callTransport.http,
        { address: ADDRESS, video: true },
        undefined,
        sharedCapability,
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(callTransport.post).not.toHaveBeenCalled();

    response.resolve({ link: FACE_TIME_LINK });
    await expect(link).resolves.toEqual({ status: 'accepted', link: FACE_TIME_LINK });
    await expect(
      startExactFaceTimeCall(
        callTransport.http,
        { address: ADDRESS, video: true },
        undefined,
        sharedCapability,
      ),
    ).resolves.toEqual({ status: 'accepted' });
    expect(callTransport.post).toHaveBeenCalledTimes(1);
  });

  it('also keeps link creation from queuing behind an active call start', async () => {
    const response = deferred<unknown>();
    const callStarted = deferred<void>();
    const callTransport = fakeHttp(async () => {
      callStarted.resolve();
      return response.promise;
    });
    const linkTransport = fakeHttp(async () => ({ link: FACE_TIME_LINK }));
    const sharedCapability = capability(true, true);

    const call = startExactFaceTimeCall(
      callTransport.http,
      { address: ADDRESS, video: true },
      undefined,
      sharedCapability,
    );
    await callStarted.promise;
    await expect(
      createExactFaceTimeLink(linkTransport.http, undefined, sharedCapability),
    ).resolves.toEqual({ status: 'rejected' });
    expect(linkTransport.post).not.toHaveBeenCalled();

    response.resolve({ started: true });
    await expect(call).resolves.toEqual({ status: 'accepted' });
  });

  it.each([
    ['facetime_call_start_invalid', 400],
    ['facetime_call_start_unavailable', 503],
    ['facetime_call_start_rejected', 409],
    ['idempotency_key_invalid', 400],
    ['idempotency_capacity_exhausted', 503],
    ['idempotency_persistence_unavailable', 503],
  ])(
    'keeps exact pre-dispatch failure %s/%i definite without retry',
    async (serverErrorType, status) => {
      const transport = fakeHttp(async () => {
        throw ApiError.fromStatus(status, 'definite refusal', undefined, serverErrorType);
      });

      await expect(
        startExactFaceTimeCall(
          transport.http,
          { address: ADDRESS, video: true },
          undefined,
          capability(),
        ),
      ).resolves.toEqual({ status: 'rejected' });
      expect(transport.post).toHaveBeenCalledTimes(1);
    },
  );

  it('treats a known error type at an unreviewed status as outcome-unknown', async () => {
    const transport = fakeHttp(async () => {
      throw ApiError.fromStatus(409, 'mixed refusal', undefined, 'facetime_call_start_unavailable');
    });

    await expect(
      startExactFaceTimeCall(
        transport.http,
        { address: ADDRESS, video: true },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'outcome-unknown' });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it.each([
    'facetime_call_start_outcome_unknown',
    'idempotency_key_reused',
    'idempotency_outcome_unknown',
  ])('keeps terminal uncertainty %s outcome-unknown without retry', async (serverErrorType) => {
    const transport = fakeHttp(async () => {
      throw ApiError.fromStatus(409, 'uncertain result', undefined, serverErrorType);
    });

    await expect(
      startExactFaceTimeCall(
        transport.http,
        { address: ADDRESS, video: false },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'outcome-unknown' });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('treats malformed success and transport failure after dispatch as unknown, never replaying', async () => {
    const malformed = fakeHttp(async () => ({ started: true, rejected: true }));
    await expect(
      startExactFaceTimeCall(
        malformed.http,
        { address: ADDRESS, video: true },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'outcome-unknown' });
    expect(malformed.post).toHaveBeenCalledTimes(1);

    const failed = fakeHttp(async () => {
      throw new ApiError('no_connection', 'response missing');
    });
    await expect(
      startExactFaceTimeCall(
        failed.http,
        { address: ADDRESS, video: true },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'outcome-unknown' });
    expect(failed.post).toHaveBeenCalledTimes(1);
  });

  it('uses a fresh attempt identity for a later user action instead of replaying', async () => {
    const random = jest
      .spyOn(Math, 'random')
      .mockReturnValueOnce(0.123456789)
      .mockReturnValueOnce(0.987654321);
    const transport = fakeHttp(async () => {
      throw new ApiError('no_connection', 'response missing');
    });

    try {
      await expect(
        startExactFaceTimeCall(
          transport.http,
          { address: ADDRESS, video: true },
          undefined,
          capability(),
        ),
      ).resolves.toEqual({ status: 'outcome-unknown' });
      await expect(
        startExactFaceTimeCall(
          transport.http,
          { address: ADDRESS, video: true },
          undefined,
          capability(),
        ),
      ).resolves.toEqual({ status: 'outcome-unknown' });
      const firstGuid = (transport.post.mock.calls[0]?.[2].json as { tempGuid: string }).tempGuid;
      const secondGuid = (transport.post.mock.calls[1]?.[2].json as { tempGuid: string }).tempGuid;
      expect(secondGuid).not.toBe(firstGuid);
      expect(transport.post).toHaveBeenCalledTimes(2);
    } finally {
      random.mockRestore();
    }
  });

  it('suppresses a late accepted result when its exact capability owner retires', async () => {
    const response = deferred<unknown>();
    const started = deferred<void>();
    const transport = fakeHttp(async () => {
      started.resolve();
      return response.promise;
    });
    let current = true;
    const source: RcsCapabilityLease = {
      kind: 'session',
      origin: 'https://facetime-call.test',
      revision: 7,
      serverInfo: ServerInfo.parse({ version: 'test', supports_facetime_call_start: true }),
      isCurrent: () => current,
      publish: () => false,
    };
    const result = startExactFaceTimeCall(
      transport.http,
      { address: ADDRESS, video: true },
      undefined,
      source,
    );
    await started.promise;
    current = false;
    response.resolve({ started: true });

    await expect(result).resolves.toEqual({ status: 'outcome-unknown' });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });
});

describe('exact FaceTime call controls', () => {
  it.each([
    ['answer', { answered: true }],
    ['leave', { left: true }],
  ] as const)(
    'pins and dispatches one exact %s request without returning the UUID',
    async (action, ack) => {
      const transport = fakeHttp(async () => ack);

      await expect(controlCall(action, transport.http, controlCapability())).resolves.toEqual({
        status: 'accepted',
      });
      expect(transport.pinTransport).toHaveBeenCalledTimes(1);
      expect(transport.post).toHaveBeenCalledTimes(1);
      expect(transport.post).toHaveBeenCalledWith(
        `/facetime/call/${action}`,
        expect.anything(),
        expect.objectContaining({
          captureErrorDetail: true,
          retry: false,
          json: {
            callUuid: CALL_UUID,
            tempGuid: expect.stringMatching(/^temp-[a-z0-9]{8}$/),
          },
        }),
      );
    },
  );

  it('publishes both optional capability flags and fails closed when the action flag is absent', async () => {
    const neither = ServerInfo.parse({ version: 'test' });
    const answer = ServerInfo.parse({ version: 'test', supports_facetime_call_answer: true });
    const leave = ServerInfo.parse({ version: 'test', supports_facetime_call_leave: true });
    expect(serverSendCapabilityKey(answer)).not.toBe(serverSendCapabilityKey(neither));
    expect(serverSendCapabilityKey(leave)).not.toBe(serverSendCapabilityKey(neither));
    expect(serverSendCapabilityKey(answer)).not.toBe(serverSendCapabilityKey(leave));

    const transport = fakeHttp(async () => ({ answered: true }));
    await expect(
      answerExactFaceTimeCall(
        transport.http,
        { callUuid: CALL_UUID },
        undefined,
        controlCapability(false, true),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).not.toHaveBeenCalled();
  });

  it('rejects a noncanonical UUID or capability proof from another origin before HTTP', async () => {
    const transport = fakeHttp(async () => ({ answered: true }));
    await expect(
      answerExactFaceTimeCall(
        transport.http,
        { callUuid: CALL_UUID.toUpperCase() },
        undefined,
        controlCapability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.pinTransport).not.toHaveBeenCalled();

    const wrongOwner: RcsCapabilityLease = {
      kind: 'session',
      origin: 'https://other-account.test',
      revision: 99,
      serverInfo: ServerInfo.parse({
        version: 'test',
        supports_facetime_call_answer: true,
      }),
      isCurrent: () => true,
      publish: () => false,
    };
    await expect(
      answerExactFaceTimeCall(transport.http, { callUuid: CALL_UUID }, undefined, wrongOwner),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).not.toHaveBeenCalled();
  });

  it('uses the existing global non-queuing lane and releases it after the active control settles', async () => {
    const response = deferred<unknown>();
    const started = deferred<void>();
    const controlTransport = fakeHttp(async () => {
      started.resolve();
      return response.promise;
    });
    const blockedTransport = fakeHttp(async () => ({ left: true }));
    const linkTransport = fakeHttp(async () => ({ link: FACE_TIME_LINK }));
    const source = controlCapability(true, true, true);

    const answer = answerExactFaceTimeCall(
      controlTransport.http,
      { callUuid: CALL_UUID },
      undefined,
      source,
    );
    await started.promise;
    await expect(
      leaveExactFaceTimeCall(blockedTransport.http, { callUuid: CALL_UUID }, undefined, source),
    ).resolves.toEqual({ status: 'rejected' });
    await expect(createExactFaceTimeLink(linkTransport.http, undefined, source)).resolves.toEqual({
      status: 'rejected',
    });
    expect(blockedTransport.post).not.toHaveBeenCalled();
    expect(linkTransport.post).not.toHaveBeenCalled();

    response.resolve({ answered: true });
    await expect(answer).resolves.toEqual({ status: 'accepted' });
    await expect(
      leaveExactFaceTimeCall(blockedTransport.http, { callUuid: CALL_UUID }, undefined, source),
    ).resolves.toEqual({ status: 'accepted' });
  });

  it.each([
    ['answer', 'facetime_call_answer_invalid', 400],
    ['answer', 'facetime_call_answer_unavailable', 503],
    ['answer', 'facetime_call_answer_rejected', 409],
    ['leave', 'facetime_call_leave_invalid', 400],
    ['leave', 'facetime_call_leave_unavailable', 503],
    ['leave', 'facetime_call_leave_rejected', 409],
    ['answer', 'idempotency_key_invalid', 400],
    ['answer', 'idempotency_capacity_exhausted', 503],
    ['answer', 'idempotency_persistence_unavailable', 503],
    ['leave', 'idempotency_key_invalid', 400],
    ['leave', 'idempotency_capacity_exhausted', 503],
    ['leave', 'idempotency_persistence_unavailable', 503],
  ] as const)(
    'keeps exact %s failure %s/%i definite without retry',
    async (action, serverErrorType, status) => {
      const transport = fakeHttp(async () => {
        throw ApiError.fromStatus(status, 'definite refusal', undefined, serverErrorType);
      });

      await expect(controlCall(action, transport.http, controlCapability())).resolves.toEqual({
        status: 'rejected',
      });
      expect(transport.post).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['answer', 'facetime_call_answer_outcome_unknown', 409],
    ['leave', 'facetime_call_leave_outcome_unknown', 409],
    ['answer', 'idempotency_key_reused', 409],
    ['leave', 'idempotency_key_reused', 409],
    ['answer', 'facetime_call_answer_unavailable', 409],
    ['leave', 'facetime_call_leave_rejected', 503],
  ] as const)(
    'keeps uncertain or wrong-status %s result %s/%i outcome-unknown without replay',
    async (action, serverErrorType, status) => {
      const transport = fakeHttp(async () => {
        throw ApiError.fromStatus(status, 'uncertain result', undefined, serverErrorType);
      });

      await expect(controlCall(action, transport.http, controlCapability())).resolves.toEqual({
        status: 'outcome-unknown',
      });
      expect(transport.post).toHaveBeenCalledTimes(1);
    },
  );

  it('uses a fresh attempt identity for each explicit later action and never replays either one', async () => {
    const random = jest
      .spyOn(Math, 'random')
      .mockReturnValueOnce(0.123456789)
      .mockReturnValueOnce(0.987654321);
    const transport = fakeHttp(async () => {
      throw new ApiError('no_connection', 'response missing');
    });

    try {
      await expect(controlCall('answer', transport.http, controlCapability())).resolves.toEqual({
        status: 'outcome-unknown',
      });
      await expect(controlCall('leave', transport.http, controlCapability())).resolves.toEqual({
        status: 'outcome-unknown',
      });
      const firstGuid = (transport.post.mock.calls[0]?.[2].json as { tempGuid: string }).tempGuid;
      const secondGuid = (transport.post.mock.calls[1]?.[2].json as { tempGuid: string }).tempGuid;
      expect(secondGuid).not.toBe(firstGuid);
      expect(transport.post).toHaveBeenCalledTimes(2);
    } finally {
      random.mockRestore();
    }
  });

  it('suppresses a late accepted marker when its exact account/capability owner retires', async () => {
    const response = deferred<unknown>();
    const started = deferred<void>();
    const transport = fakeHttp(async () => {
      started.resolve();
      return response.promise;
    });
    let current = true;
    const source: RcsCapabilityLease = {
      kind: 'session',
      origin: 'https://facetime-call.test',
      revision: 7,
      serverInfo: ServerInfo.parse({
        version: 'test',
        supports_facetime_call_answer: true,
      }),
      isCurrent: () => current,
      publish: () => false,
    };
    const result = answerExactFaceTimeCall(
      transport.http,
      { callUuid: CALL_UUID },
      () => current,
      source,
    );
    await started.promise;
    current = false;
    response.resolve({ answered: true });

    await expect(result).resolves.toEqual({ status: 'outcome-unknown' });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });
});
