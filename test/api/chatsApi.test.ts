import { createChat, markChatUnread } from '@core/api/endpoints/chats';
import type { HttpClient } from '@core/api/http';

describe('chatsApi.createChat', () => {
  it('POSTs /chat/new with addresses, message, and defaults service/method', async () => {
    const post = jest.fn((..._a: unknown[]) => Promise.resolve({ guid: 'iMessage;-;+1555' }));
    const http = { post } as unknown as HttpClient;
    await createChat(http, { addresses: ['+1555'], message: 'hi' });
    expect(post).toHaveBeenCalledWith('/chat/new', expect.anything(), {
      json: { addresses: ['+1555'], message: 'hi', service: 'iMessage', method: 'private-api' },
    });
  });

  it('honors an explicit service (SMS)', async () => {
    const post = jest.fn((..._a: unknown[]) => Promise.resolve({ guid: 'x' }));
    const http = { post } as unknown as HttpClient;
    await createChat(http, { addresses: ['+1555'], message: 'hey', service: 'SMS' });
    expect(post).toHaveBeenCalledWith(
      '/chat/new',
      expect.anything(),
      expect.objectContaining({ json: expect.objectContaining({ service: 'SMS' }) }),
    );
  });
});

describe('chatsApi.markChatUnread', () => {
  it('POSTs /chat/{guid}/unread with the guid encoded into the PATH, never the query', async () => {
    const post = jest.fn((..._a: unknown[]) => Promise.resolve({}));
    const http = { post } as unknown as HttpClient;
    const guid = 'iMessage;-;+15551234567';
    await markChatUnread(http, guid);
    expect(post).toHaveBeenCalledTimes(1);
    const [path, , opts] = post.mock.calls[0]!;
    expect(path).toBe(`/chat/${encodeURIComponent(guid)}/unread`);
    expect(path).not.toContain('?'); // no query string at all
    expect(opts).toBeUndefined(); // and no options object smuggling a { query: { guid } }
  });
});
