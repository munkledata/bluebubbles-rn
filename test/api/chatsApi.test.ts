import * as chatsApi from '@core/api/endpoints/chats';
import { createChat, markChatRead } from '@core/api/endpoints/chats';
import type { HttpClient } from '@core/api/http';

describe('chatsApi helper retirement', () => {
  it('does not export helper-only group mutation endpoints', () => {
    expect(chatsApi).not.toHaveProperty('renameChat');
    expect(chatsApi).not.toHaveProperty('updateParticipant');
    expect(chatsApi).not.toHaveProperty('leaveChat');
  });
});

describe('chatsApi.createChat', () => {
  it('POSTs one RCS recipient without the retired helper method selector', async () => {
    const post = jest.fn((..._a: unknown[]) => Promise.resolve({ guid: 'RCS;-;+1555' }));
    const http = { post } as unknown as HttpClient;
    await createChat(http, { address: '+1555', message: 'hi' });
    expect(post).toHaveBeenCalledWith('/chat/new', expect.anything(), {
      json: { addresses: ['+1555'], message: 'hi', service: 'RCS' },
    });
  });

  it('rejects a legacy iMessage response instead of adopting a helper-created chat', async () => {
    const post = jest.fn((..._a: unknown[]) => Promise.resolve({ guid: 'iMessage;-;+1555' }));
    const http = { post } as unknown as HttpClient;

    await expect(createChat(http, { address: '+1555', message: 'hi' })).rejects.toThrow(
      'non-RCS conversation',
    );
  });
});

describe('chatsApi.markChatRead', () => {
  it('rejects an iMessage read marker before HTTP', () => {
    const post = jest.fn();
    const http = { post } as unknown as HttpClient;

    expect(() => markChatRead(http, 'iMessage;-;+1555')).toThrow('only for RCS');
    expect(post).not.toHaveBeenCalled();
  });

  it('preserves the supported RCS read marker', async () => {
    const post = jest.fn(() => Promise.resolve({}));
    const http = { post } as unknown as HttpClient;

    await markChatRead(http, 'RCS;-;+1555');
    expect(post).toHaveBeenCalledWith('/chat/RCS%3B-%3B%2B1555/read', expect.anything());
  });
});
