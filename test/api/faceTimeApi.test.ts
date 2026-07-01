import {
  answerFaceTime,
  createFaceTimeLink,
  startFaceTimeCall,
} from '@core/api/endpoints/facetime';
import type { HttpClient } from '@core/api/http';

describe('faceTimeApi', () => {
  it('answerFaceTime POSTs /facetime/:uuid/answer and reports the ack', async () => {
    const post = jest.fn(() => Promise.resolve({ answered: true }));
    const http = { post } as unknown as HttpClient;
    await expect(answerFaceTime(http, 'AB-CD')).resolves.toBe(true);
    expect(post).toHaveBeenCalledWith('/facetime/AB-CD/answer', expect.anything(), { json: {} });
  });

  it('createFaceTimeLink returns the minted link', async () => {
    const post = jest.fn(() => Promise.resolve({ link: 'https://facetime.apple.com/join#x' }));
    const http = { post } as unknown as HttpClient;
    await expect(createFaceTimeLink(http)).resolves.toBe('https://facetime.apple.com/join#x');
  });

  it('startFaceTimeCall POSTs /facetime/call with addresses + video and returns uuid+link', async () => {
    const post = jest.fn(() =>
      Promise.resolve({ call_uuid: 'UUID-1', link: 'https://facetime.apple.com/join#y' }),
    );
    const http = { post } as unknown as HttpClient;
    const res = await startFaceTimeCall(http, { addresses: ['+1555', 'a@b.com'], video: true });
    expect(post).toHaveBeenCalledWith('/facetime/call', expect.anything(), {
      json: { addresses: ['+1555', 'a@b.com'], video: true },
    });
    expect(res).toEqual({ callUuid: 'UUID-1', link: 'https://facetime.apple.com/join#y' });
  });

  it('startFaceTimeCall tolerates a call placed without a returned link', async () => {
    const post = jest.fn(() => Promise.resolve({ call_uuid: 'UUID-2' }));
    const http = { post } as unknown as HttpClient;
    await expect(startFaceTimeCall(http, { addresses: ['+1555'], video: false })).resolves.toEqual({
      callUuid: 'UUID-2',
      link: null,
    });
  });
});
