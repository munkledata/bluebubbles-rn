import { sendEffect } from '@core/api/endpoints/messages';
import { ApiError } from '@core/api/errors';
import type { HttpClient, RequestOptions } from '@core/api/http';
import { IMESSAGE_EFFECT_OPTIONS } from '@core/effects';

const CHAT_GUID = 'iMessage;-;+15551234567';
const TEMP_GUID = 'temp-effect-1';
const SLAM = 'com.apple.MobileSMS.expressivesend.impact';

function fakeHttp(result: unknown): { http: HttpClient; post: jest.Mock } {
  const post = jest.fn<Promise<unknown>, [string, unknown, RequestOptions]>(async () => result);
  return { http: { post } as unknown as HttpClient, post };
}

describe('message effect endpoint', () => {
  it('owns exactly the twelve reviewed IDs and POSTs the exact idempotent body once', async () => {
    expect(IMESSAGE_EFFECT_OPTIONS).toHaveLength(12);
    expect(new Set(IMESSAGE_EFFECT_OPTIONS.map((effect) => effect.id))).toHaveProperty('size', 12);
    const transport = fakeHttp({ guid: 'real-effect-guid', viaPrivateApi: true });

    await expect(
      sendEffect(transport.http, {
        chatGuid: CHAT_GUID,
        tempGuid: TEMP_GUID,
        message: 'boom',
        effectId: SLAM,
      }),
    ).resolves.toEqual({ guid: 'real-effect-guid', viaPrivateApi: true });

    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post).toHaveBeenCalledWith('/message/effect', expect.anything(), {
      captureErrorDetail: true,
      retry: false,
      json: {
        chatGuid: CHAT_GUID,
        tempGuid: TEMP_GUID,
        message: 'boom',
        effectId: SLAM,
      },
    });
  });

  it('rejects an unknown effect, blank text, or non-temp identity before HTTP', async () => {
    const transport = fakeHttp({ guid: 'must-not-send', viaPrivateApi: true });

    await expect(
      sendEffect(transport.http, {
        chatGuid: CHAT_GUID,
        tempGuid: TEMP_GUID,
        message: 'hello',
        effectId: 'not-an-apple-effect',
      }),
    ).rejects.toThrow('not supported');
    await expect(
      sendEffect(transport.http, {
        chatGuid: CHAT_GUID,
        tempGuid: TEMP_GUID,
        message: '   ',
        effectId: SLAM,
      }),
    ).rejects.toThrow('cannot be blank');
    await expect(
      sendEffect(transport.http, {
        chatGuid: CHAT_GUID,
        tempGuid: 'real-guid',
        message: 'hello',
        effectId: SLAM,
      }),
    ).rejects.toThrow('temporary GUID');
    expect(transport.post).not.toHaveBeenCalled();
  });

  it('turns a malformed success into typed outcome-unknown but preserves reviewed failures', async () => {
    const malformed = fakeHttp({ guid: TEMP_GUID, viaPrivateApi: true });
    const malformedError = await sendEffect(malformed.http, {
      chatGuid: CHAT_GUID,
      tempGuid: TEMP_GUID,
      message: 'hello',
      effectId: SLAM,
    }).catch((error: unknown) => error);
    expect(malformedError).toBeInstanceOf(ApiError);
    expect((malformedError as ApiError).serverErrorType).toBe('imessage_effect_outcome_unknown');

    const rejected = ApiError.fromStatus(409, 'rejected', undefined, 'imessage_effect_rejected');
    const post = jest.fn(async () => {
      throw rejected;
    });
    await expect(
      sendEffect({ post } as unknown as HttpClient, {
        chatGuid: CHAT_GUID,
        tempGuid: TEMP_GUID,
        message: 'hello',
        effectId: SLAM,
      }),
    ).rejects.toBe(rejected);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
