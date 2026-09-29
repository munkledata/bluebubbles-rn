import { sendMention } from '@core/api/endpoints/messages';
import { ApiError } from '@core/api/errors';
import type { HttpClient, RequestOptions } from '@core/api/http';

const CHAT_GUID = 'iMessage;+;chat-mention-1';
const TEMP_GUID = 'temp-mention-1';
const MENTIONS = [
  { start: 6, length: 5, address: 'alice@example.test' },
  { start: 16, length: 3, address: '+15551234567' },
];

function fakeHttp(result: unknown): { http: HttpClient; post: jest.Mock } {
  const post = jest.fn<Promise<unknown>, [string, unknown, RequestOptions]>(async () => result);
  return { http: { post } as unknown as HttpClient, post };
}

describe('message mention endpoint', () => {
  it('POSTs one exact non-retrying request and accepts a strict helper acknowledgement', async () => {
    const transport = fakeHttp({ guid: 'real-mention-guid', viaPrivateApi: true });

    await expect(
      sendMention(transport.http, {
        chatGuid: CHAT_GUID,
        tempGuid: TEMP_GUID,
        message: 'Hello Alice and Bob',
        mentions: MENTIONS,
      }),
    ).resolves.toEqual({ guid: 'real-mention-guid', viaPrivateApi: true });

    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post).toHaveBeenCalledWith('/message/mention', expect.anything(), {
      captureErrorDetail: true,
      retry: false,
      json: {
        chatGuid: CHAT_GUID,
        tempGuid: TEMP_GUID,
        message: 'Hello Alice and Bob',
        mentions: MENTIONS,
      },
    });
  });

  it('rejects an inexact group or invalid UTF-16 mention topology before HTTP', async () => {
    const transport = fakeHttp({ guid: 'must-not-send', viaPrivateApi: true });

    await expect(
      sendMention(transport.http, {
        chatGuid: 'iMessage;-;+15551234567',
        tempGuid: TEMP_GUID,
        message: 'Hello Alice',
        mentions: [{ start: 6, length: 5, address: 'alice@example.test' }],
      }),
    ).rejects.toThrow('exact existing iMessage group');
    await expect(
      sendMention(transport.http, {
        chatGuid: CHAT_GUID,
        tempGuid: TEMP_GUID,
        message: 'Hi 👩🏽‍💻',
        mentions: [{ start: 3, length: 2, address: 'alice@example.test' }],
      }),
    ).rejects.toThrow('complete visible labels');
    await expect(
      sendMention(transport.http, {
        chatGuid: CHAT_GUID,
        tempGuid: TEMP_GUID,
        message: 'Alice Bob',
        mentions: [
          { start: 6, length: 3, address: '+15551234567' },
          { start: 0, length: 5, address: 'alice@example.test' },
        ],
      }),
    ).rejects.toThrow('sorted and non-overlapping');
    await expect(
      sendMention(transport.http, {
        chatGuid: CHAT_GUID,
        tempGuid: TEMP_GUID,
        message: 'Hello Alice',
        mentions: [{ start: 6, length: 5, address: 'alice\t@example.test' }],
      }),
    ).rejects.toThrow('exact participant address');
    expect(transport.post).not.toHaveBeenCalled();
  });

  it('types malformed acknowledgements as outcome-unknown and preserves reviewed refusals', async () => {
    const malformed = fakeHttp({ guid: 'real-mention-guid', viaPrivateApi: false });
    const malformedError = await sendMention(malformed.http, {
      chatGuid: CHAT_GUID,
      tempGuid: TEMP_GUID,
      message: 'Hello Alice',
      mentions: [{ start: 6, length: 5, address: 'alice@example.test' }],
    }).catch((error: unknown) => error);
    expect(malformedError).toBeInstanceOf(ApiError);
    expect((malformedError as ApiError).serverErrorType).toBe('imessage_mention_outcome_unknown');

    const widened = fakeHttp({
      guid: 'real-mention-guid',
      viaPrivateApi: true,
      unexpected: 'not part of the narrow acknowledgement',
    });
    const widenedError = await sendMention(widened.http, {
      chatGuid: CHAT_GUID,
      tempGuid: TEMP_GUID,
      message: 'Hello Alice',
      mentions: [{ start: 6, length: 5, address: 'alice@example.test' }],
    }).catch((error: unknown) => error);
    expect(widenedError).toBeInstanceOf(ApiError);
    expect((widenedError as ApiError).serverErrorType).toBe('imessage_mention_outcome_unknown');

    const rejected = ApiError.fromStatus(409, 'rejected', undefined, 'imessage_mention_rejected');
    const post = jest.fn(async () => {
      throw rejected;
    });
    await expect(
      sendMention({ post } as unknown as HttpClient, {
        chatGuid: CHAT_GUID,
        tempGuid: TEMP_GUID,
        message: 'Hello Alice',
        mentions: [{ start: 6, length: 5, address: 'alice@example.test' }],
      }),
    ).rejects.toBe(rejected);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('types an uncertain transport failure as outcome-unknown', async () => {
    const transportFailure = new ApiError('no_connection', 'request connection ended');
    const post = jest.fn(async () => {
      throw transportFailure;
    });

    const error = await sendMention({ post } as unknown as HttpClient, {
      chatGuid: CHAT_GUID,
      tempGuid: TEMP_GUID,
      message: 'Hello Alice',
      mentions: [{ start: 6, length: 5, address: 'alice@example.test' }],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).serverErrorType).toBe('imessage_mention_outcome_unknown');
    expect((error as ApiError).cause).toBe(transportFailure);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not trust a definite error name paired with the wrong HTTP status', async () => {
    const mismatched = ApiError.fromStatus(
      500,
      'mismatched refusal',
      undefined,
      'imessage_mention_invalid_target',
    );
    const post = jest.fn(async () => {
      throw mismatched;
    });

    const error = await sendMention({ post } as unknown as HttpClient, {
      chatGuid: CHAT_GUID,
      tempGuid: TEMP_GUID,
      message: 'Hello Alice',
      mentions: [{ start: 6, length: 5, address: 'alice@example.test' }],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).serverErrorType).toBe('imessage_mention_outcome_unknown');
    expect((error as ApiError).cause).toBe(mismatched);
  });
});
