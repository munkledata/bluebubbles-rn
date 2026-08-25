import type { HttpClient, RequestOptions } from '@core/api/http';
import {
  editMessage,
  sendContact,
  sendReaction,
  sendText,
  unsendMessage,
} from '@core/api/endpoints/messages';

describe('message endpoint error-detail capture', () => {
  it('opts in only the three optimistic send endpoint wrappers', async () => {
    const post = jest.fn<Promise<unknown>, [string, unknown, RequestOptions]>(async () => ({}));
    const http = { post } as unknown as HttpClient;

    await sendText(http, { chatGuid: 'chat-1', tempGuid: 'temp-text', message: 'hello' });
    await sendContact(http, { chatGuid: 'chat-1', tempGuid: 'temp-contact', firstName: 'Ada' });
    await sendReaction(http, {
      chatGuid: 'chat-1',
      selectedMessageGuid: 'target-1',
      reaction: 'love',
    });
    await editMessage(http, {
      chatGuid: 'chat-1',
      messageGuid: 'message-1',
      editedMessage: 'edited',
      backwardsCompatibilityMessage: 'Edited to “edited”',
    });
    await unsendMessage(http, { chatGuid: 'chat-1', messageGuid: 'message-1' });

    expect(post.mock.calls.slice(0, 3).map((call) => call[2]?.captureErrorDetail)).toEqual([
      true,
      true,
      true,
    ]);
    expect(post.mock.calls.slice(3).map((call) => call[2]?.captureErrorDetail)).toEqual([
      undefined,
      undefined,
    ]);
  });
});
