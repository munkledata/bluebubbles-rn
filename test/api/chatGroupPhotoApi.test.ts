import {
  parseIMessageGroupPhotoSetResponse,
  removeIMessageGroupPhoto,
} from '@core/api/endpoints/chats';
import { ApiError } from '@core/api/errors';
import type { HttpClient, RequestOptions } from '@core/api/http';

const CHAT_GUID = 'iMessage;+;chat123456789';
const TEMP_GUID = 'temp-photo1';

function fakeHttp(result: unknown): { http: HttpClient; remove: jest.Mock } {
  const remove = jest.fn<Promise<unknown>, [string, unknown, RequestOptions]>(async () => result);
  return { http: { delete: remove } as unknown as HttpClient, remove };
}

describe('iMessage group photo endpoint contract', () => {
  it('DELETEs exactly one idempotent removal without retry and requires a matching strict ack', async () => {
    const transport = fakeHttp({ removed: true, guid: CHAT_GUID, operation: 'remove' });

    await expect(
      removeIMessageGroupPhoto(transport.http, { chatGuid: CHAT_GUID, tempGuid: TEMP_GUID }),
    ).resolves.toEqual({ removed: true, guid: CHAT_GUID, operation: 'remove' });
    expect(transport.remove).toHaveBeenCalledTimes(1);
    expect(transport.remove).toHaveBeenCalledWith(
      '/chat/iMessage%3B%2B%3Bchat123456789/icon',
      expect.anything(),
      {
        captureErrorDetail: true,
        retry: false,
        signal: undefined,
        json: { tempGuid: TEMP_GUID },
      },
    );
  });

  it.each([
    { removed: true, guid: 'iMessage;+;wrong', operation: 'remove' },
    { removed: true, guid: CHAT_GUID, operation: 'set' },
    { removed: true, guid: CHAT_GUID, operation: 'remove', extra: true },
  ])('treats a malformed or mismatched remove ack as outcome unknown', async (ack) => {
    const transport = fakeHttp(ack);
    const error = await removeIMessageGroupPhoto(transport.http, {
      chatGuid: CHAT_GUID,
      tempGuid: TEMP_GUID,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).serverErrorType).toBe('imessage_group_photo_outcome_unknown');
    expect(transport.remove).toHaveBeenCalledTimes(1);
  });

  it('parses only the exact matching native-upload envelope', () => {
    expect(
      parseIMessageGroupPhotoSetResponse(
        JSON.stringify({
          status: 200,
          message: 'Success',
          data: { updated: true, guid: CHAT_GUID, operation: 'set' },
        }),
        200,
        { chatGuid: CHAT_GUID, tempGuid: TEMP_GUID },
      ),
    ).toEqual({ updated: true, guid: CHAT_GUID, operation: 'set' });

    for (const data of [
      { updated: true, guid: 'iMessage;+;wrong', operation: 'set' },
      { updated: true, guid: CHAT_GUID, operation: 'remove' },
      { updated: true, guid: CHAT_GUID, operation: 'set', extra: true },
    ]) {
      expect(() =>
        parseIMessageGroupPhotoSetResponse(JSON.stringify({ status: 200, data }), 200, {
          chatGuid: CHAT_GUID,
          tempGuid: TEMP_GUID,
        }),
      ).toThrow(ApiError);
    }
  });
});
