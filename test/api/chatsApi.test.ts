import * as chatsApi from '@core/api/endpoints/chats';
import { createChat, markChatRead, markChatUnread } from '@core/api/endpoints/chats';
import type { HttpClient } from '@core/api/http';

const RCS_PROVIDER_EPOCH = `gpe1_${'A'.repeat(43)}`;
const RCS_CHAT_GUID = `RCS;-;g1.${RCS_PROVIDER_EPOCH}.${Buffer.from('+1555').toString('base64url')}`;

describe('chatsApi helper retirement', () => {
  it('does not export helper-only group mutation endpoints', () => {
    expect(chatsApi).not.toHaveProperty('renameChat');
    expect(chatsApi).not.toHaveProperty('updateParticipant');
    expect(chatsApi).not.toHaveProperty('leaveChat');
  });
});

describe('chatsApi.createChat', () => {
  it('POSTs one RCS recipient without the retired helper method selector', async () => {
    const post = jest.fn((..._a: unknown[]) => Promise.resolve({ guid: RCS_CHAT_GUID }));
    const http = { post } as unknown as HttpClient;
    await expect(
      createChat(http, {
        address: '+1555',
        message: 'hi',
        service: 'RCS',
        providerEpoch: RCS_PROVIDER_EPOCH,
      }),
    ).resolves.toMatchObject({
      guid: RCS_CHAT_GUID,
      participants: [{ address: '+1555', service: 'RCS' }],
    });
    expect(post).toHaveBeenCalledWith('/chat/new', expect.anything(), {
      captureErrorDetail: true,
      json: {
        addresses: ['+1555'],
        message: 'hi',
        service: 'RCS',
        providerEpoch: RCS_PROVIDER_EPOCH,
      },
    });
  });

  it('rejects a response for a different service instead of opening that chat', async () => {
    const post = jest.fn((..._a: unknown[]) => Promise.resolve({ guid: 'iMessage;-;+1555' }));
    const http = { post } as unknown as HttpClient;

    await expect(
      createChat(http, {
        address: '+1555',
        message: 'hi',
        service: 'RCS',
        providerEpoch: RCS_PROVIDER_EPOCH,
      }),
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

    post.mockResolvedValueOnce({ guid: RCS_CHAT_GUID });
    await expect(createChat(http, params)).rejects.toThrow('wrong service');
  });

  it('rejects a native Messages chat ID for an RCS create', async () => {
    const post = jest.fn(async () => ({ guid: 'any;-;+1555' }));
    const http = { post } as unknown as HttpClient;
    await expect(
      createChat(http, {
        address: '+1555',
        message: 'hi',
        service: 'RCS',
        providerEpoch: RCS_PROVIDER_EPOCH,
      }),
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
  it('rejects unsupported and malformed read-state targets before HTTP', () => {
    const post = jest.fn();
    const http = { post } as unknown as HttpClient;

    expect(() => markChatRead(http, 'SMS;-;+1555')).toThrow('RCS or one-to-one iMessage');
    expect(() => markChatRead(http, 'iMessage;-;')).toThrow('RCS or one-to-one iMessage');
    expect(() => markChatRead(http, `iMessage;-;${'a'.repeat(1_025)}`)).toThrow(
      'RCS or one-to-one iMessage',
    );
    expect(() => markChatRead(http, 'iMessage;-;+1555\n')).toThrow('RCS or one-to-one iMessage');
    expect(() => markChatUnread(http, 'RCS;-;+1555')).toThrow('one-to-one iMessage');
    expect(post).not.toHaveBeenCalled();
  });

  it('preserves the supported RCS read marker without enabling retries', async () => {
    const post = jest.fn(() => Promise.resolve({}));
    const http = { post } as unknown as HttpClient;

    await markChatRead(http, 'RCS;-;+1555');
    expect(post).toHaveBeenCalledWith('/chat/RCS%3B-%3B%2B1555/read', expect.anything(), {
      retry: false,
    });
  });

  it('posts iMessage read and unread state once with no automatic retry', async () => {
    const post = jest.fn(() => Promise.resolve({}));
    const http = { post } as unknown as HttpClient;

    await markChatRead(http, 'iMessage;-;+1555');
    await markChatUnread(http, 'any;-;+1666');

    expect(post).toHaveBeenNthCalledWith(
      1,
      '/chat/iMessage%3B-%3B%2B1555/read',
      expect.anything(),
      { retry: false },
    );
    expect(post).toHaveBeenNthCalledWith(2, '/chat/any%3B-%3B%2B1666/unread', expect.anything(), {
      retry: false,
    });
  });
});

describe('chatsApi.findOrCreateRcsChat', () => {
  const chat = (overrides: Record<string, unknown> = {}) => ({
    guid: RCS_CHAT_GUID,
    providerEpoch: RCS_PROVIDER_EPOCH,
    style: 45,
    participants: [{ address: '+1555', service: 'RCS' }],
    ...overrides,
  });

  it('POSTs the address and pairing and returns the one-to-one RCS chat', async () => {
    const post = jest.fn((..._a: unknown[]) => Promise.resolve({ chat: chat() }));
    const http = { post } as unknown as HttpClient;

    await expect(
      chatsApi.findOrCreateRcsChat(http, '+1555', RCS_PROVIDER_EPOCH),
    ).resolves.toMatchObject({ guid: RCS_CHAT_GUID, style: 45 });
    expect(post).toHaveBeenCalledWith('/rcs/chat/find-or-create', expect.anything(), {
      captureErrorDetail: true,
      json: { address: '+1555', providerEpoch: RCS_PROVIDER_EPOCH },
    });
  });

  it('refuses a group, another service, or another pairing', async () => {
    for (const reply of [
      chat({ style: 43 }),
      chat({ guid: 'iMessage;-;+1555' }),
      chat({ providerEpoch: `gpe1_${'B'.repeat(42)}A` }),
    ]) {
      const http = {
        post: jest.fn(() => Promise.resolve({ chat: reply })),
      } as unknown as HttpClient;
      await expect(chatsApi.findOrCreateRcsChat(http, '+1555', RCS_PROVIDER_EPOCH)).rejects.toThrow(
        'not this one-to-one RCS chat',
      );
    }
  });

  it('refuses a malformed pairing before any request', async () => {
    const post = jest.fn();
    await expect(
      chatsApi.findOrCreateRcsChat({ post } as unknown as HttpClient, '+1555', 'not-an-epoch'),
    ).rejects.toThrow('pairing epoch');
    expect(post).not.toHaveBeenCalled();
  });
});
