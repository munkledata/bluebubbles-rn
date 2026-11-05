import { remoteDeleteMessage } from '@core/api/endpoints/messages';
import type { HttpClient, RequestOptions } from '@core/api/http';

const MESSAGE_GUID = 'message-delete-1';
const ANY_GROUP_GUID = 'any;+;chat123456789';

function fakeHttp(): { http: HttpClient; post: jest.Mock } {
  const post = jest.fn<Promise<unknown>, [string, unknown, RequestOptions]>(async () => ({
    deleted: true,
    guid: MESSAGE_GUID,
  }));
  return { http: { post } as unknown as HttpClient, post };
}

describe('remote delete endpoint addressing', () => {
  it('takes an any;+; group only from a caller that proved the restored gate', async () => {
    const transport = fakeHttp();
    const params = { chatGuid: ANY_GROUP_GUID, messageGuid: MESSAGE_GUID };

    expect(() => remoteDeleteMessage(transport.http, params)).toThrow(
      'exact existing iMessage conversation',
    );
    expect(() => remoteDeleteMessage(transport.http, params, { restoredGroup: false })).toThrow(
      'exact existing iMessage conversation',
    );
    expect(transport.post).not.toHaveBeenCalled();

    await expect(
      remoteDeleteMessage(transport.http, params, { restoredGroup: true }),
    ).resolves.toEqual({ deleted: true, guid: MESSAGE_GUID });
    expect(transport.post).toHaveBeenCalledWith(
      `/message/${MESSAGE_GUID}/remote-delete`,
      expect.anything(),
      { captureErrorDetail: true, retry: false, json: { chatGuid: ANY_GROUP_GUID } },
    );
  });

  it.each([false, true])(
    'keeps the reviewed addresses and refuses every other shape (gate proved: %s)',
    (restoredGroup) => {
      for (const chatGuid of [
        'iMessage;-;+15551234567',
        'any;-;+15551234567',
        'iMessage;+;chat123456789',
      ]) {
        expect(() =>
          remoteDeleteMessage(
            fakeHttp().http,
            { chatGuid, messageGuid: MESSAGE_GUID },
            { restoredGroup },
          ),
        ).not.toThrow();
      }
      for (const chatGuid of [
        'SMS;+;chat123456789',
        'RCS;-;+15551234567',
        'any;+;',
        ' any;+;chat123456789',
      ]) {
        expect(() =>
          remoteDeleteMessage(
            fakeHttp().http,
            { chatGuid, messageGuid: MESSAGE_GUID },
            { restoredGroup },
          ),
        ).toThrow('exact existing iMessage conversation');
      }
    },
  );
});
