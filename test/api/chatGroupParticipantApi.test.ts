import {
  addIMessageGroupParticipant,
  leaveIMessageGroup,
  removeIMessageGroupParticipant,
} from '@core/api/endpoints/chats';
import { ApiError } from '@core/api/errors';
import type { HttpClient, RequestOptions } from '@core/api/http';

const CHAT_GUID = 'iMessage;+;chat123456789';
const ADDRESS = '+15551234567';
const TEMP_GUID = 'temp-participant1';

function fakeHttp(result: unknown): { http: HttpClient; post: jest.Mock } {
  const post = jest.fn<Promise<unknown>, [string, unknown, RequestOptions]>(async () => result);
  return { http: { post } as unknown as HttpClient, post };
}

describe('iMessage group participant-add endpoint', () => {
  it('POSTs the exact non-retrying body and accepts only the matching acknowledgement', async () => {
    const transport = fakeHttp({ added: true, guid: CHAT_GUID, address: ADDRESS });

    await expect(
      addIMessageGroupParticipant(transport.http, {
        chatGuid: CHAT_GUID,
        address: ADDRESS,
        tempGuid: TEMP_GUID,
      }),
    ).resolves.toEqual({ added: true, guid: CHAT_GUID, address: ADDRESS });
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post).toHaveBeenCalledWith(
      '/chat/iMessage%3B%2B%3Bchat123456789/participants/add',
      expect.anything(),
      {
        captureErrorDetail: true,
        retry: false,
        json: { address: ADDRESS, tempGuid: TEMP_GUID },
      },
    );
  });

  it.each(['5551234567', '+0123456789', ' not@example.com', 'not-an-email'])(
    'rejects non-canonical address %j before HTTP',
    async (address) => {
      const transport = fakeHttp({ added: true, guid: CHAT_GUID, address });
      await expect(
        addIMessageGroupParticipant(transport.http, {
          chatGuid: CHAT_GUID,
          address,
          tempGuid: TEMP_GUID,
        }),
      ).rejects.toThrow('canonical E.164 number or email');
      expect(transport.post).not.toHaveBeenCalled();
    },
  );

  it('preserves valid email spelling instead of silently rewriting the target', async () => {
    const address = 'Person@Example.COM';
    const transport = fakeHttp({ added: true, guid: CHAT_GUID, address });

    await expect(
      addIMessageGroupParticipant(transport.http, {
        chatGuid: CHAT_GUID,
        address,
        tempGuid: TEMP_GUID,
      }),
    ).resolves.toEqual({ added: true, guid: CHAT_GUID, address });
    expect(transport.post.mock.calls[0]?.[2].json).toEqual({ address, tempGuid: TEMP_GUID });
  });

  it.each([
    { added: true, guid: 'iMessage;+;wrong', address: ADDRESS },
    { added: true, guid: CHAT_GUID, address: 'other@example.com' },
    { added: true, guid: CHAT_GUID, address: ADDRESS, extra: true },
    { guid: CHAT_GUID, address: ADDRESS },
  ])('treats malformed or mismatched success as outcome unknown', async (ack) => {
    const transport = fakeHttp(ack);
    const error = await addIMessageGroupParticipant(transport.http, {
      chatGuid: CHAT_GUID,
      address: ADDRESS,
      tempGuid: TEMP_GUID,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).serverErrorType).toBe(
      'imessage_group_participant_add_outcome_unknown',
    );
    expect(transport.post).toHaveBeenCalledTimes(1);
  });
});

describe('iMessage group participant-remove endpoint', () => {
  it('POSTs the exact non-retrying body and accepts only the matching acknowledgement', async () => {
    const transport = fakeHttp({ removed: true, guid: CHAT_GUID, address: ADDRESS });

    await expect(
      removeIMessageGroupParticipant(transport.http, {
        chatGuid: CHAT_GUID,
        address: ADDRESS,
        tempGuid: TEMP_GUID,
      }),
    ).resolves.toEqual({ removed: true, guid: CHAT_GUID, address: ADDRESS });
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post).toHaveBeenCalledWith(
      '/chat/iMessage%3B%2B%3Bchat123456789/participants/remove',
      expect.anything(),
      {
        captureErrorDetail: true,
        retry: false,
        json: { address: ADDRESS, tempGuid: TEMP_GUID },
      },
    );
  });

  it('rejects an invalid target or unstable identity before HTTP', async () => {
    const transport = fakeHttp({ removed: true, guid: CHAT_GUID, address: ADDRESS });

    await expect(
      removeIMessageGroupParticipant(transport.http, {
        chatGuid: 'iMessage;-;+15551234567',
        address: ADDRESS,
        tempGuid: TEMP_GUID,
      }),
    ).rejects.toThrow('exact existing iMessage group');
    await expect(
      removeIMessageGroupParticipant(transport.http, {
        chatGuid: CHAT_GUID,
        address: '5551234567',
        tempGuid: TEMP_GUID,
      }),
    ).rejects.toThrow('canonical E.164 number or email');
    await expect(
      removeIMessageGroupParticipant(transport.http, {
        chatGuid: CHAT_GUID,
        address: ADDRESS,
        tempGuid: 'unstable',
      }),
    ).rejects.toThrow('temporary GUID');
    expect(transport.post).not.toHaveBeenCalled();
  });

  it.each([
    { removed: true, guid: 'iMessage;+;wrong', address: ADDRESS },
    { removed: true, guid: CHAT_GUID, address: 'other@example.com' },
    { removed: true, guid: CHAT_GUID, address: ADDRESS, extra: true },
    { guid: CHAT_GUID, address: ADDRESS },
  ])('treats malformed or mismatched success as outcome unknown', async (ack) => {
    const transport = fakeHttp(ack);
    const error = await removeIMessageGroupParticipant(transport.http, {
      chatGuid: CHAT_GUID,
      address: ADDRESS,
      tempGuid: TEMP_GUID,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).serverErrorType).toBe(
      'imessage_group_participant_remove_outcome_unknown',
    );
    expect(transport.post).toHaveBeenCalledTimes(1);
  });
});

describe('iMessage group leave endpoint', () => {
  it('POSTs only one tempGuid without retry and accepts an exact acknowledgement', async () => {
    const transport = fakeHttp({ left: true, guid: CHAT_GUID });

    await expect(
      leaveIMessageGroup(transport.http, { chatGuid: CHAT_GUID, tempGuid: TEMP_GUID }),
    ).resolves.toEqual({ left: true, guid: CHAT_GUID });
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post).toHaveBeenCalledWith(
      '/chat/iMessage%3B%2B%3Bchat123456789/leave',
      expect.anything(),
      {
        captureErrorDetail: true,
        retry: false,
        json: { tempGuid: TEMP_GUID },
      },
    );
  });

  it('rejects an invalid group or unstable identity before HTTP', async () => {
    const transport = fakeHttp({ left: true, guid: CHAT_GUID });

    await expect(
      leaveIMessageGroup(transport.http, {
        chatGuid: 'iMessage;-;+15551234567',
        tempGuid: TEMP_GUID,
      }),
    ).rejects.toThrow('exact existing iMessage group');
    await expect(
      leaveIMessageGroup(transport.http, { chatGuid: CHAT_GUID, tempGuid: 'unstable' }),
    ).rejects.toThrow('temporary GUID');
    expect(transport.post).not.toHaveBeenCalled();
  });

  it.each([
    { left: true, guid: 'iMessage;+;wrong' },
    { left: true, guid: CHAT_GUID, extra: true },
    { guid: CHAT_GUID },
  ])('keeps malformed or mismatched success as outcome unknown', async (ack) => {
    const transport = fakeHttp(ack);
    const error = await leaveIMessageGroup(transport.http, {
      chatGuid: CHAT_GUID,
      tempGuid: TEMP_GUID,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).serverErrorType).toBe('imessage_group_leave_outcome_unknown');
    expect(transport.post).toHaveBeenCalledTimes(1);
  });
});
