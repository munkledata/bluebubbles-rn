import type { HttpClient, RequestOptions } from '@core/api/http';
import {
  editMessage,
  sendContact,
  sendReaction,
  sendText,
  unsendMessage,
} from '@core/api/endpoints/messages';

describe('message endpoint error-detail capture', () => {
  it('opts in only the three retained optimistic send endpoint wrappers', async () => {
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

    expect(() =>
      editMessage(http, {
        chatGuid: 'chat-1',
        messageGuid: 'message-1',
        editedMessage: 'edited',
        backwardsCompatibilityMessage: 'Edited to “edited”',
        partIndex: 0,
      }),
    ).toThrow('Editing iMessages was retired with the Private API helper.');
    expect(() =>
      unsendMessage(http, { chatGuid: 'chat-1', messageGuid: 'message-1', partIndex: 0 }),
    ).toThrow('Unsend was retired with the Private API helper.');

    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls.map((call) => call[2]?.captureErrorDetail)).toEqual([true, true, true]);
  });
});
