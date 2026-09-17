import type { HttpClient } from '@core/api/http';
import type { AppDatabase } from '@db/types';
import { sendEdit, sendUnsend } from '@/services/send/sendEditService';

describe('retired edit and unsend boundaries', () => {
  const db = {} as AppDatabase;

  it('rejects edit before HTTP even when a stale caller supplies a complete target', async () => {
    const post = jest.fn();
    await expect(
      sendEdit(db, { post } as unknown as HttpClient, {
        chatGuid: 'iMessage;-;stale',
        messageGuid: 'm1',
        newText: 'edited',
        partIndex: 0,
      }),
    ).rejects.toThrow('retired with the Private API helper');
    expect(post).not.toHaveBeenCalled();
  });

  it('rejects unsend before HTTP even when a stale caller supplies a complete target', async () => {
    const post = jest.fn();
    await expect(
      sendUnsend(db, { post } as unknown as HttpClient, {
        chatGuid: 'iMessage;-;stale',
        messageGuid: 'm1',
        partIndex: 0,
      }),
    ).rejects.toThrow('retired with the Private API helper');
    expect(post).not.toHaveBeenCalled();
  });
});
