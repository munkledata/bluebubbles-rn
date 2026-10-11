import type { HttpClient, RequestOptions } from '@core/api/http';
import { ApiError } from '@core/api/errors';
import {
  editMessage,
  isRetryableIMessagePlainTextUnavailable,
  sendIMessagePlainText,
  sendContact,
  sendReaction,
  sendText,
  unsendMessage,
} from '@core/api/endpoints/messages';

describe('message endpoint error-detail capture', () => {
  it('opts narrow edit and unsend into detail capture without transport retry', async () => {
    const post = jest.fn<Promise<unknown>, [string, unknown, RequestOptions]>(async () => ({}));
    const http = { post } as unknown as HttpClient;
    const rcsChatGuid = 'RCS;-;chat-1';

    await sendText(http, { chatGuid: 'chat-1', tempGuid: 'temp-text', message: 'hello' });
    await sendContact(http, {
      chatGuid: rcsChatGuid,
      tempGuid: 'temp-contact',
      firstName: 'Ada',
    });
    await sendReaction(http, {
      chatGuid: rcsChatGuid,
      selectedMessageGuid: 'target-1',
      reaction: 'love',
      partIndex: 0,
    });
    await editMessage(http, {
      chatGuid: 'iMessage;-;+15551234567',
      messageGuid: 'message-1',
      editedMessage: 'edited',
      partIndex: 0,
    });
    await unsendMessage(http, {
      chatGuid: 'iMessage;-;+15551234567',
      messageGuid: 'message-1',
      partIndex: 0,
    });

    expect(post).toHaveBeenCalledTimes(5);
    expect(post.mock.calls.map((call) => call[2]?.captureErrorDetail)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(post.mock.calls[3]?.[0]).toBe('/message/message-1/edit');
    expect(post.mock.calls[3]?.[2]).toMatchObject({
      retry: false,
      json: {
        chatGuid: 'iMessage;-;+15551234567',
        editedText: 'edited',
        partIndex: 0,
      },
    });
    expect(post.mock.calls[3]?.[2]?.json).not.toHaveProperty('backwardsCompatText');
    expect(post.mock.calls[4]).toEqual([
      '/message/message-1/unsend',
      expect.anything(),
      {
        captureErrorDetail: true,
        retry: false,
        json: { chatGuid: 'iMessage;-;+15551234567', partIndex: 0 },
      },
    ]);
  });
});

describe('narrow plain iMessage endpoint', () => {
  const chatGuid = 'any;-;+15551234567';
  const tempGuid = 'temp-plain-1';
  const guid = '11111111-2222-4333-8444-555555555555';

  it('uses one exact non-retrying envelope and requires the echoed temporary identity', async () => {
    const post = jest.fn<Promise<unknown>, [string, unknown, RequestOptions]>(async () => ({
      guid,
      tempGuid,
      viaPrivateApi: true,
    }));

    await expect(
      sendIMessagePlainText({ post } as unknown as HttpClient, {
        chatGuid,
        message: 'hello',
        tempGuid,
      }),
    ).resolves.toEqual({ guid, tempGuid, viaPrivateApi: true });
    expect(post).toHaveBeenCalledWith('/message/imessage-text', expect.anything(), {
      captureErrorDetail: true,
      retry: false,
      json: { chatGuid, message: 'hello', tempGuid },
    });

    post.mockResolvedValueOnce({ guid, tempGuid: 'temp-other', viaPrivateApi: true });
    const malformed = await sendIMessagePlainText({ post } as unknown as HttpClient, {
      chatGuid,
      message: 'hello',
      tempGuid,
    }).catch((error: unknown) => error);
    expect(malformed).toBeInstanceOf(ApiError);
    expect((malformed as ApiError).serverErrorType).toBe('imessage_plain_text_outcome_unknown');
  });

  it.each([
    [
      'the helper being unavailable',
      ApiError.fromStatus(503, 'unavailable', undefined, 'imessage_plain_text_unavailable'),
    ],
    [
      'durable retry protection being down',
      ApiError.fromStatus(
        503,
        'settlement unavailable',
        undefined,
        'idempotency_persistence_unavailable',
      ),
    ],
    [
      'the retry cache being full',
      ApiError.fromStatus(503, 'capacity', undefined, 'idempotency_capacity_exhausted'),
    ],
    ['no connection', new ApiError('no_connection', 'Network request failed')],
    ['a client timeout', new ApiError('timeout', 'Request timed out')],
    ['an untyped proxy 502', ApiError.fromStatus(502, 'Bad Gateway')],
  ])('passes %s through as retry-safe instead of "may have been delivered"', async (_l, error) => {
    const post = jest.fn(async () => {
      throw error;
    });
    await expect(
      sendIMessagePlainText({ post } as unknown as HttpClient, {
        chatGuid,
        message: 'hello',
        tempGuid,
      }),
    ).rejects.toBe(error);
    expect(isRetryableIMessagePlainTextUnavailable(error)).toBe(true);
  });

  it.each([
    [
      'the server itself reporting an unknown outcome',
      ApiError.fromStatus(409, 'unknown', undefined, 'imessage_plain_text_outcome_unknown'),
    ],
    [
      'the retry cache reporting an unknown outcome',
      ApiError.fromStatus(500, 'unknown', undefined, 'idempotency_outcome_unknown'),
    ],
  ])('keeps %s terminal', async (_label, error) => {
    const post = jest.fn(async () => {
      throw error;
    });
    await expect(
      sendIMessagePlainText({ post } as unknown as HttpClient, {
        chatGuid,
        message: 'hello',
        tempGuid,
      }),
    ).rejects.toBe(error);
    expect(isRetryableIMessagePlainTextUnavailable(error)).toBe(false);
  });

  it.each([
    [
      'an invalid retry key',
      ApiError.fromStatus(400, 'invalid', undefined, 'idempotency_key_invalid'),
    ],
    [
      'a retry key used for a different request',
      ApiError.fromStatus(409, 'reused', undefined, 'idempotency_key_reused'),
    ],
  ])('passes %s through intact so it reads as not sent', async (_label, error) => {
    const post = jest.fn(async () => {
      throw error;
    });
    await expect(
      sendIMessagePlainText({ post } as unknown as HttpClient, {
        chatGuid,
        message: 'hello',
        tempGuid,
      }),
    ).rejects.toBe(error);
    expect(isRetryableIMessagePlainTextUnavailable(error)).toBe(false);
  });

  it('treats an unreadable success response as possibly sent', async () => {
    const malformedBody = new ApiError('parse_error', 'Response body could not be read', 200);
    const post = jest.fn(async () => {
      throw malformedBody;
    });
    const wrapped = await sendIMessagePlainText({ post } as unknown as HttpClient, {
      chatGuid,
      message: 'hello',
      tempGuid,
    }).catch((error: unknown) => error);
    expect((wrapped as ApiError).serverErrorType).toBe('imessage_plain_text_outcome_unknown');
    expect((wrapped as ApiError).cause).toBe(malformedBody);
    expect(isRetryableIMessagePlainTextUnavailable(wrapped)).toBe(false);
  });
});
