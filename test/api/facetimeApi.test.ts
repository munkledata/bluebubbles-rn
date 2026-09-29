import {
  answerFaceTimeCall,
  createFaceTimeLink,
  isCanonicalAppleFaceTimeLink,
  isCanonicalFaceTimeCallAddress,
  isCanonicalFaceTimeCallUuid,
  leaveFaceTimeCall,
  startFaceTimeCall,
} from '@core/api/endpoints/facetime';
import { ApiError } from '@core/api/errors';
import type { HttpClient, RequestOptions } from '@core/api/http';

const TEMP_GUID = 'temp-link1234';
const CALL_UUID = '01234567-89ab-cdef-0123-456789abcdef';
const FACE_TIME_LINK = `https://facetime.apple.com/join#v=1&p=${'A'.repeat(22)}&k=${'A'.repeat(43)}`;

function fakeHttp(result: unknown): { http: HttpClient; post: jest.Mock } {
  const post = jest.fn<Promise<unknown>, [string, unknown, RequestOptions]>(async () => result);
  return { http: { post } as unknown as HttpClient, post };
}

describe('FaceTime link endpoint', () => {
  it('POSTs one exact non-retrying body and accepts an exact canonical Apple link', async () => {
    const transport = fakeHttp({ link: FACE_TIME_LINK });

    await expect(createFaceTimeLink(transport.http, { tempGuid: TEMP_GUID })).resolves.toEqual({
      link: FACE_TIME_LINK,
    });
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post).toHaveBeenCalledWith('/facetime/link', expect.anything(), {
      captureErrorDetail: true,
      retry: false,
      json: { tempGuid: TEMP_GUID },
    });
  });

  it('recognizes only canonical 16-byte participant and 32-byte key base64url values', () => {
    expect(isCanonicalAppleFaceTimeLink(FACE_TIME_LINK)).toBe(true);
    expect(
      isCanonicalAppleFaceTimeLink(
        `https://facetime.apple.com/join#v=1&p=${'A'.repeat(21)}B&k=${'A'.repeat(43)}`,
      ),
    ).toBe(false);
    expect(
      isCanonicalAppleFaceTimeLink(
        `https://facetime.apple.com/join#v=1&p=${'A'.repeat(22)}&k=${'A'.repeat(42)}B`,
      ),
    ).toBe(false);
    expect(isCanonicalAppleFaceTimeLink(`${FACE_TIME_LINK}&extra=true`)).toBe(false);
    expect(isCanonicalAppleFaceTimeLink(FACE_TIME_LINK.replace('/join#', '/join?#'))).toBe(false);
  });

  it.each([
    { link: `${FACE_TIME_LINK}&extra=true` },
    { link: FACE_TIME_LINK, extra: true },
    {},
    null,
  ])('turns malformed or widened success into a redacted outcome-unknown error', async (ack) => {
    const transport = fakeHttp(ack);
    const error = await createFaceTimeLink(transport.http, { tempGuid: TEMP_GUID }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).serverErrorType).toBe('facetime_link_outcome_unknown');
    expect(String(error)).not.toContain('facetime.apple.com');
    expect((error as ApiError).cause).toBeUndefined();
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('passes through an exact typed server refusal and rejects an invalid identity before HTTP', async () => {
    const refused = ApiError.fromStatus(409, 'rejected', undefined, 'facetime_link_rejected');
    const post = jest.fn(async () => {
      throw refused;
    });
    await expect(
      createFaceTimeLink({ post } as unknown as HttpClient, { tempGuid: TEMP_GUID }),
    ).rejects.toBe(refused);

    const transport = fakeHttp({ link: FACE_TIME_LINK });
    await expect(
      createFaceTimeLink(transport.http, { tempGuid: 'replayable-user-value' }),
    ).rejects.toThrow('temporary GUID');
    expect(transport.post).not.toHaveBeenCalled();
  });
});

describe('FaceTime call-start endpoint', () => {
  const ADDRESS = 'alice@example.com';

  it('POSTs one exact non-retrying body and accepts only the reserved success marker', async () => {
    const transport = fakeHttp({ started: true });

    await expect(
      startFaceTimeCall(transport.http, {
        address: ADDRESS,
        video: false,
        tempGuid: TEMP_GUID,
      }),
    ).resolves.toEqual({ started: true });
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post).toHaveBeenCalledWith('/facetime/call', expect.anything(), {
      captureErrorDetail: true,
      retry: false,
      json: { address: ADDRESS, video: false, tempGuid: TEMP_GUID },
    });
  });

  it.each(['+15551234567', '+12', 'alice@example.com', 'a.b+tag@sub.example.co'])(
    'accepts canonical call address %s without rewriting it',
    (address) => {
      expect(isCanonicalFaceTimeCallAddress(address)).toBe(true);
    },
  );

  it('matches the helper email allowlist and exact byte/label limits', () => {
    expect(isCanonicalFaceTimeCallAddress("az09!#$%&'*+-/=?^_`{|}~.next@example.com")).toBe(true);
    expect(isCanonicalFaceTimeCallAddress(`${'a'.repeat(64)}@example.com`)).toBe(true);
    expect(isCanonicalFaceTimeCallAddress(`${'a'.repeat(65)}@example.com`)).toBe(false);
    expect(isCanonicalFaceTimeCallAddress(`a@${'b'.repeat(63)}.com`)).toBe(true);
    expect(isCanonicalFaceTimeCallAddress(`a@${'b'.repeat(64)}.com`)).toBe(false);

    const exactly254 = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    const over254 = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`;
    expect(exactly254).toHaveLength(254);
    expect(over254).toHaveLength(255);
    expect(isCanonicalFaceTimeCallAddress(exactly254)).toBe(true);
    expect(isCanonicalFaceTimeCallAddress(over254)).toBe(false);
  });

  it.each([
    '15551234567',
    '+0123456789',
    '+1234567890123456',
    ' Alice@example.com',
    'Alice@example.com',
    'álîçé@example.com',
    '.alice@example.com',
    'alice.@example.com',
    'alice..smith@example.com',
    'alice@example',
    'alice@-example.com',
    'alice@example-.com',
  ])('rejects noncanonical call address %s', (address) => {
    expect(isCanonicalFaceTimeCallAddress(address)).toBe(false);
  });

  it('rejects a noncanonical address, non-Boolean video, or invalid attempt id before HTTP', async () => {
    const transport = fakeHttp({ started: true });

    await expect(
      startFaceTimeCall(transport.http, {
        address: 'Alice@example.com',
        video: false,
        tempGuid: TEMP_GUID,
      }),
    ).rejects.toThrow('lowercase ASCII email');
    await expect(
      startFaceTimeCall(transport.http, {
        address: ADDRESS,
        video: 'false' as unknown as boolean,
        tempGuid: TEMP_GUID,
      }),
    ).rejects.toThrow('exact audio/video choice');
    await expect(
      startFaceTimeCall(transport.http, {
        address: ADDRESS,
        video: true,
        tempGuid: 'replayable-user-value',
      }),
    ).rejects.toThrow('temporary GUID');
    expect(transport.post).not.toHaveBeenCalled();
  });

  it.each([
    { started: false },
    { started: true, extra: true },
    { started: true, error: { type: 'facetime_call_start_rejected' } },
    {},
    null,
  ])('treats malformed or mixed post-boundary result %# as outcome-unknown', async (ack) => {
    const transport = fakeHttp(ack);
    const error = await startFaceTimeCall(transport.http, {
      address: ADDRESS,
      video: true,
      tempGuid: TEMP_GUID,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).serverErrorType).toBe('facetime_call_start_outcome_unknown');
    expect((error as ApiError).cause).toBeUndefined();
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('passes through an exact typed server refusal and redacts a transport parse failure', async () => {
    const refused = ApiError.fromStatus(409, 'rejected', undefined, 'facetime_call_start_rejected');
    const refusalPost = jest.fn(async () => {
      throw refused;
    });
    await expect(
      startFaceTimeCall({ post: refusalPost } as unknown as HttpClient, {
        address: ADDRESS,
        video: true,
        tempGuid: TEMP_GUID,
      }),
    ).rejects.toBe(refused);

    const parseFailure = new ApiError('parse_error', 'hostile mixed response', 200, {
      address: ADDRESS,
    });
    const parsePost = jest.fn(async () => {
      throw parseFailure;
    });
    const error = await startFaceTimeCall({ post: parsePost } as unknown as HttpClient, {
      address: ADDRESS,
      video: false,
      tempGuid: TEMP_GUID,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).serverErrorType).toBe('facetime_call_start_outcome_unknown');
    expect((error as ApiError).cause).toBeUndefined();
  });
});

describe('FaceTime call-control endpoints', () => {
  it.each([
    ['answer', answerFaceTimeCall, { answered: true }],
    ['leave', leaveFaceTimeCall, { left: true }],
  ] as const)(
    'POSTs one exact non-retrying %s body and accepts its reserved marker',
    async (action, control, ack) => {
      const transport = fakeHttp(ack);

      await expect(
        control(transport.http, { callUuid: CALL_UUID, tempGuid: TEMP_GUID }),
      ).resolves.toEqual(ack);
      expect(transport.post).toHaveBeenCalledTimes(1);
      expect(transport.post).toHaveBeenCalledWith(`/facetime/call/${action}`, expect.anything(), {
        captureErrorDetail: true,
        retry: false,
        json: { callUuid: CALL_UUID, tempGuid: TEMP_GUID },
      });
    },
  );

  it('matches the helper lowercase UUID grammar exactly and rejects invalid input before HTTP', async () => {
    expect(isCanonicalFaceTimeCallUuid(CALL_UUID)).toBe(true);
    expect(isCanonicalFaceTimeCallUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(isCanonicalFaceTimeCallUuid(CALL_UUID.toUpperCase())).toBe(false);
    expect(isCanonicalFaceTimeCallUuid(`{${CALL_UUID}}`)).toBe(false);
    expect(isCanonicalFaceTimeCallUuid(CALL_UUID.slice(0, -1))).toBe(false);

    const transport = fakeHttp({ answered: true });
    await expect(
      answerFaceTimeCall(transport.http, {
        callUuid: CALL_UUID.toUpperCase(),
        tempGuid: TEMP_GUID,
      }),
    ).rejects.toThrow('lowercase call UUID');
    await expect(
      answerFaceTimeCall(transport.http, {
        callUuid: CALL_UUID,
        tempGuid: 'replayable-user-value',
      }),
    ).rejects.toThrow('temporary GUID');
    expect(transport.post).not.toHaveBeenCalled();
  });

  it.each([
    ['answer', answerFaceTimeCall, { answered: false }, 'facetime_call_answer_outcome_unknown'],
    [
      'answer',
      answerFaceTimeCall,
      { answered: true, rejected: true },
      'facetime_call_answer_outcome_unknown',
    ],
    ['leave', leaveFaceTimeCall, { left: false }, 'facetime_call_leave_outcome_unknown'],
    [
      'leave',
      leaveFaceTimeCall,
      { left: true, rejected: true },
      'facetime_call_leave_outcome_unknown',
    ],
  ] as const)(
    'turns malformed or mixed %s result into action-specific outcome-unknown',
    async (_action, control, ack, errorType) => {
      const transport = fakeHttp(ack);
      const error = await control(transport.http, {
        callUuid: CALL_UUID,
        tempGuid: TEMP_GUID,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).serverErrorType).toBe(errorType);
      expect((error as ApiError).cause).toBeUndefined();
      expect(String(error)).not.toContain(CALL_UUID);
      expect(transport.post).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['answer', answerFaceTimeCall, 'facetime_call_answer_rejected'],
    ['leave', leaveFaceTimeCall, 'facetime_call_leave_rejected'],
  ] as const)(
    'passes through an exact typed %s refusal and redacts parse failure',
    async (_action, control, refusalType) => {
      const refused = ApiError.fromStatus(409, 'rejected', undefined, refusalType);
      const refusalPost = jest.fn(async () => {
        throw refused;
      });
      await expect(
        control({ post: refusalPost } as unknown as HttpClient, {
          callUuid: CALL_UUID,
          tempGuid: TEMP_GUID,
        }),
      ).rejects.toBe(refused);

      const parseFailure = new ApiError('parse_error', 'hostile mixed response', 200, {
        callUuid: CALL_UUID,
      });
      const parsePost = jest.fn(async () => {
        throw parseFailure;
      });
      const error = await control({ post: parsePost } as unknown as HttpClient, {
        callUuid: CALL_UUID,
        tempGuid: TEMP_GUID,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).serverErrorType).toBe(`facetime_call_${_action}_outcome_unknown`);
      expect((error as ApiError).cause).toBeUndefined();
      expect(String(error)).not.toContain(CALL_UUID);
    },
  );
});
