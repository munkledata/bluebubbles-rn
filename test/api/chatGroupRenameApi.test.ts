import { renameIMessageGroup } from '@core/api/endpoints/chats';
import { ApiError } from '@core/api/errors';
import type { HttpClient, RequestOptions } from '@core/api/http';

const CHAT_GUID = 'iMessage;+;chat123456789';
const TEMP_GUID = 'temp-rename1';

function fakeHttp(result: unknown): { http: HttpClient; post: jest.Mock } {
  const post = jest.fn<Promise<unknown>, [string, unknown, RequestOptions]>(async () => result);
  return { http: { post } as unknown as HttpClient, post };
}

describe('iMessage group rename endpoint', () => {
  it('POSTs the exact idempotent body once and requires an exact success acknowledgement', async () => {
    const transport = fakeHttp({ renamed: true, guid: CHAT_GUID, displayName: 'Road Trip' });

    await expect(
      renameIMessageGroup(transport.http, {
        chatGuid: CHAT_GUID,
        displayName: 'Road Trip',
        tempGuid: TEMP_GUID,
      }),
    ).resolves.toEqual({ renamed: true, guid: CHAT_GUID, displayName: 'Road Trip' });

    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post).toHaveBeenCalledWith(
      '/chat/iMessage%3B%2B%3Bchat123456789/rename',
      expect.anything(),
      {
        captureErrorDetail: true,
        retry: false,
        json: { displayName: 'Road Trip', tempGuid: TEMP_GUID },
      },
    );
  });

  it('rejects a DM, invalid name, or unstable identity before HTTP', async () => {
    const transport = fakeHttp({ renamed: true, guid: CHAT_GUID, displayName: 'unused' });

    await expect(
      renameIMessageGroup(transport.http, {
        chatGuid: 'iMessage;-;+15551234567',
        displayName: 'Road Trip',
        tempGuid: TEMP_GUID,
      }),
    ).rejects.toThrow('exact existing iMessage group');
    await expect(
      renameIMessageGroup(transport.http, {
        chatGuid: CHAT_GUID,
        displayName: '   ',
        tempGuid: TEMP_GUID,
      }),
    ).rejects.toThrow('non-control text');
    await expect(
      renameIMessageGroup(transport.http, {
        chatGuid: CHAT_GUID,
        displayName: 'a'.repeat(257),
        tempGuid: TEMP_GUID,
      }),
    ).rejects.toThrow('bounded');
    await expect(
      renameIMessageGroup(transport.http, {
        chatGuid: CHAT_GUID,
        displayName: 'Road Trip',
        tempGuid: 'rename-without-temp-prefix',
      }),
    ).rejects.toThrow('temporary GUID');
    expect(transport.post).not.toHaveBeenCalled();
  });

  it.each([
    { renamed: true, guid: 'iMessage;+;wrong', displayName: 'Road Trip' },
    { renamed: true, guid: CHAT_GUID, displayName: 'Different Name' },
    { renamed: true, guid: CHAT_GUID, displayName: 'Road Trip', extra: true },
    { guid: CHAT_GUID, displayName: 'Road Trip' },
  ])('treats malformed or mismatched success as outcome unknown', async (ack) => {
    const transport = fakeHttp(ack);

    const error = await renameIMessageGroup(transport.http, {
      chatGuid: CHAT_GUID,
      displayName: 'Road Trip',
      tempGuid: TEMP_GUID,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).serverErrorType).toBe('imessage_group_rename_outcome_unknown');
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('passes through a reviewed definite server refusal without retrying', async () => {
    const rejected = ApiError.fromStatus(
      409,
      'rejected',
      undefined,
      'imessage_group_rename_rejected',
    );
    const post = jest.fn(async () => {
      throw rejected;
    });

    await expect(
      renameIMessageGroup({ post } as unknown as HttpClient, {
        chatGuid: CHAT_GUID,
        displayName: 'Road Trip',
        tempGuid: TEMP_GUID,
      }),
    ).rejects.toBe(rejected);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
