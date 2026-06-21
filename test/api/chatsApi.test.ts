import { createChat } from '@core/api/endpoints/chats';
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
