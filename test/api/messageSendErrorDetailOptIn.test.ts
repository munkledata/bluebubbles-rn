import type { HttpClient, RequestOptions } from '@core/api/http';
import {
  editMessage,
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
