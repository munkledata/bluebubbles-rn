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
    await expect(
      createChat(http, { address: '+1555', message: 'hi', service: 'RCS' }),
    ).resolves.toMatchObject({
      guid: 'RCS;-;+1555',
      participants: [{ address: '+1555', service: 'RCS' }],
    });
    expect(post).toHaveBeenCalledWith('/chat/new', expect.anything(), {
      captureErrorDetail: true,
      json: { addresses: ['+1555'], message: 'hi', service: 'RCS' },
    });
  });

  it('rejects a response for a different service instead of opening that chat', async () => {
    const post = jest.fn((..._a: unknown[]) => Promise.resolve({ guid: 'iMessage;-;+1555' }));
    const http = { post } as unknown as HttpClient;

    await expect(
      createChat(http, { address: '+1555', message: 'hi', service: 'RCS' }),
    ).rejects.toThrow('wrong service');
  });

  it('POSTs one iMessage recipient with a stable id and creates a provisional local participant', async () => {
    // The paired helper may return a canonical iMessage alias rather than the input address.
    const post = jest.fn(async () => ({ guid: 'iMessage;-;+1666' }));
    const http = { post } as unknown as HttpClient;
    await expect(
      createChat(http, {
        address: '+1555',
        message: 'hi',
        service: 'iMessage',
        tempGuid: 'temp-stable-1',
      }),
    ).resolves.toMatchObject({
      guid: 'iMessage;-;+1666',
      participants: [{ address: '+1555', service: 'iMessage' }],
    });
    expect(post).toHaveBeenCalledWith('/chat/new', expect.anything(), {
      captureErrorDetail: true,
      json: {
        addresses: ['+1555'],
        message: 'hi',
        service: 'iMessage',
        tempGuid: 'temp-stable-1',
      },
    });
  });

  it('accepts only the requested native Messages chat ID for an iMessage create', async () => {
    const post = jest.fn(async () => ({ guid: 'any;-;+1555' }));
    const http = { post } as unknown as HttpClient;
    const params = {
      address: '+1555',
      message: 'hi',
      service: 'iMessage' as const,
      tempGuid: 'temp-stable-1',
    };

    await expect(createChat(http, params)).resolves.toMatchObject({
      guid: 'any;-;+1555',
      participants: [{ address: '+1555', service: 'iMessage' }],
    });

    post.mockResolvedValueOnce({ guid: 'any;-;+1666' });
    await expect(createChat(http, params)).rejects.toThrow('wrong service');

    post.mockResolvedValueOnce({ guid: 'SMS;-;+1555' });
    await expect(createChat(http, params)).rejects.toThrow('wrong service');

    post.mockResolvedValueOnce({ guid: 'RCS;-;+1555' });
    await expect(createChat(http, params)).rejects.toThrow('wrong service');
  });

  it('rejects a native Messages chat ID for an RCS create', async () => {
    const post = jest.fn(async () => ({ guid: 'any;-;+1555' }));
    const http = { post } as unknown as HttpClient;
    await expect(
      createChat(http, { address: '+1555', message: 'hi', service: 'RCS' }),
    ).rejects.toThrow('wrong service');
  });

  it('refuses iMessage create without a stable id before HTTP', async () => {
    const post = jest.fn();
    await expect(
      createChat({ post } as unknown as HttpClient, {
        address: '+1555',
        message: 'hi',
        service: 'iMessage',
      }),
    ).rejects.toThrow('stable request identity');
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses an unsupported service before HTTP even from an untyped caller', async () => {
    const post = jest.fn();
    await expect(
      createChat({ post } as unknown as HttpClient, {
        address: '+1555',
        message: 'hi',
        service: 'SMS' as 'RCS',
      }),
    ).rejects.toThrow('cannot be started');
    expect(post).not.toHaveBeenCalled();
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
