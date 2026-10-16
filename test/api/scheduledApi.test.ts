import { createScheduled, deleteScheduled, getScheduled } from '@core/api/endpoints/scheduled';
import type { HttpClient } from '@core/api/http';

const item = {
  id: 'uuid-1',
  chatGuid: 'iMessage;-;+1555',
  text: 'hi',
  scheduledFor: 1_700_000_000_000,
};

describe('scheduledApi', () => {
  it('getScheduled GETs /scheduled-message and unwraps scheduledMessages', async () => {
    const get = jest.fn((..._a: unknown[]) => Promise.resolve({ scheduledMessages: [item] }));
    const http = { get } as unknown as HttpClient;
    expect(await getScheduled(http)).toEqual([item]);
    expect(get).toHaveBeenCalledWith('/scheduled-message', expect.anything());
  });

  it('getScheduled tolerates a missing list key', async () => {
    const get = jest.fn((..._a: unknown[]) => Promise.resolve({ scheduledMessages: null }));
    const http = { get } as unknown as HttpClient;
    expect(await getScheduled(http)).toEqual([]);
  });

  it('createScheduled POSTs the flat Gator body ({ text }, not { message })', async () => {
    const post = jest.fn((..._a: unknown[]) => Promise.resolve(item));
    const http = { post } as unknown as HttpClient;
    const res = await createScheduled(http, {
      chatGuid: item.chatGuid,
      message: 'hi',
      scheduledFor: item.scheduledFor,
    });
    expect(post).toHaveBeenCalledWith('/scheduled-message', expect.anything(), {
      json: { chatGuid: item.chatGuid, text: 'hi', scheduledFor: item.scheduledFor },
    });
    expect(res).toEqual(item);
  });

  it('sends the narrow file fields only for an attachment schedule', async () => {
    const post = jest.fn((..._a: unknown[]) =>
      Promise.resolve({
        ...item,
        method: 'narrow-attachment',
        attachmentName: 'small.png',
      }),
    );
    const http = { post } as unknown as HttpClient;
    await createScheduled(http, {
      chatGuid: item.chatGuid,
      message: 'caption',
      scheduledFor: item.scheduledFor,
      method: 'narrow-attachment',
      attachmentName: 'small.png',
      attachmentData: 'AQID',
    });
    expect(post).toHaveBeenCalledWith('/scheduled-message', expect.anything(), {
      json: {
        chatGuid: item.chatGuid,
        text: 'caption',
        scheduledFor: item.scheduledFor,
        method: 'narrow-attachment',
        attachmentName: 'small.png',
        attachmentData: 'AQID',
      },
    });
  });

  it('deleteScheduled DELETEs /scheduled-message/{id}', async () => {
    const del = jest.fn((..._a: unknown[]) => Promise.resolve({ removed: true }));
    const http = { delete: del } as unknown as HttpClient;
    await deleteScheduled(http, 'uuid-1');
    expect(del).toHaveBeenCalledWith('/scheduled-message/uuid-1', expect.anything(), {
      captureErrorDetail: true,
      retry: false,
    });
  });

  it('keeps a server id with path, query or fragment characters inside one segment (review M140)', async () => {
    const del = jest.fn((..._a: unknown[]) => Promise.resolve({ removed: true }));
    const http = { delete: del } as unknown as HttpClient;
    await deleteScheduled(http, 'a/b?c#d');
    expect(del).toHaveBeenCalledWith('/scheduled-message/a%2Fb%3Fc%23d', expect.anything(), {
      captureErrorDetail: true,
      retry: false,
    });
  });

  it.each(['', '.', '..'])(
    'refuses the dot-segment or empty id %j before any request (review M140)',
    async (id) => {
      const del = jest.fn((..._a: unknown[]) => Promise.resolve({ removed: true }));
      const http = { delete: del } as unknown as HttpClient;
      await expect(deleteScheduled(http, id)).rejects.toThrow('not a valid path segment');
      expect(del).not.toHaveBeenCalled();
    },
  );
});
