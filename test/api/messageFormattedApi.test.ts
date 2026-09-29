import { sendFormatted, type IMessageTextFormattingRange } from '@core/api/endpoints/messages';
import { ApiError } from '@core/api/errors';
import type { HttpClient, RequestOptions } from '@core/api/http';

const CHAT_GUID = 'iMessage;-;+15551234567';
const TEMP_GUID = 'temp-format-1';
const FORMATTING: IMessageTextFormattingRange[] = [
  { start: 0, length: 5, styles: ['bold'] },
  { start: 6, length: 5, styles: ['italic', 'underline'] },
];

function fakeHttp(result: unknown): { http: HttpClient; post: jest.Mock } {
  const post = jest.fn<Promise<unknown>, [string, unknown, RequestOptions]>(async () => result);
  return { http: { post } as unknown as HttpClient, post };
}

describe('formatted message endpoint', () => {
  it('POSTs one strict non-retrying request and accepts an exact helper acknowledgement', async () => {
    const transport = fakeHttp({ guid: 'real-formatted-guid', viaPrivateApi: true });

    await expect(
      sendFormatted(transport.http, {
        chatGuid: CHAT_GUID,
        tempGuid: TEMP_GUID,
        message: 'Hello world',
        textFormatting: FORMATTING,
      }),
    ).resolves.toEqual({ guid: 'real-formatted-guid', viaPrivateApi: true });

    expect(transport.post).toHaveBeenCalledWith('/message/formatted', expect.anything(), {
      captureErrorDetail: true,
      retry: false,
      json: {
        chatGuid: CHAT_GUID,
        tempGuid: TEMP_GUID,
        message: 'Hello world',
        textFormatting: FORMATTING,
      },
    });
  });

  it('rejects group targets, split graphemes, overlaps, and noncanonical styles before HTTP', async () => {
    const transport = fakeHttp({ guid: 'must-not-send', viaPrivateApi: true });
    const base = { tempGuid: TEMP_GUID, message: 'Hi 👩🏽‍💻' };

    await expect(
      sendFormatted(transport.http, {
        ...base,
        chatGuid: 'iMessage;+;group',
        textFormatting: [{ start: 0, length: 2, styles: ['bold'] }],
      }),
    ).rejects.toThrow('one-to-one conversation');
    await expect(
      sendFormatted(transport.http, {
        ...base,
        chatGuid: CHAT_GUID,
        textFormatting: [{ start: 3, length: 2, styles: ['bold'] }],
      }),
    ).rejects.toThrow('complete characters');
    await expect(
      sendFormatted(transport.http, {
        chatGuid: CHAT_GUID,
        tempGuid: TEMP_GUID,
        message: 'Hello world',
        textFormatting: [
          { start: 0, length: 7, styles: ['bold'] },
          { start: 6, length: 5, styles: ['italic'] },
        ],
      }),
    ).rejects.toThrow('sorted and non-overlapping');
    await expect(
      sendFormatted(transport.http, {
        chatGuid: CHAT_GUID,
        tempGuid: TEMP_GUID,
        message: 'Hello',
        textFormatting: [{ start: 0, length: 5, styles: ['italic', 'bold'] }],
      }),
    ).rejects.toThrow('unique and canonically ordered');
    expect(transport.post).not.toHaveBeenCalled();
  });

  it('permits bounded underline and strikethrough ranges on spaces', async () => {
    const transport = fakeHttp({ guid: 'real-formatted-guid', viaPrivateApi: true });
    await expect(
      sendFormatted(transport.http, {
        chatGuid: CHAT_GUID,
        tempGuid: TEMP_GUID,
        message: 'A B C',
        textFormatting: [
          { start: 1, length: 1, styles: ['underline'] },
          { start: 3, length: 1, styles: ['strikethrough'] },
        ],
      }),
    ).resolves.toEqual({ guid: 'real-formatted-guid', viaPrivateApi: true });
  });

  it('preserves reviewed refusals and types every ambiguous result as outcome-unknown', async () => {
    const rejected = ApiError.fromStatus(
      409,
      'rejected',
      undefined,
      'imessage_formatted_message_rejected',
    );
    const definitePost = jest.fn(async () => {
      throw rejected;
    });
    await expect(
      sendFormatted({ post: definitePost } as unknown as HttpClient, {
        chatGuid: CHAT_GUID,
        tempGuid: TEMP_GUID,
        message: 'Hello world',
        textFormatting: FORMATTING,
      }),
    ).rejects.toBe(rejected);

    const malformed = fakeHttp({ guid: 'real-formatted-guid', viaPrivateApi: false });
    const error = await sendFormatted(malformed.http, {
      chatGuid: CHAT_GUID,
      tempGuid: TEMP_GUID,
      message: 'Hello world',
      textFormatting: FORMATTING,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).serverErrorType).toBe('imessage_formatted_message_outcome_unknown');
  });
});
