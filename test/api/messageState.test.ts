import ky from 'ky';
import { HttpClient } from '@core/api/http';
import * as messageStateApi from '@core/api/endpoints/messageState';
import * as repairApi from '@core/api/endpoints/repairSnapshot';

jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));

const mockKy = ky as unknown as jest.Mock;
const providerEpoch = '11111111-1111-4111-8111-111111111111';
const ledgerEpoch = '22222222-2222-4222-8222-222222222222';
const client = new HttpClient({
  getOrigin: () => 'https://fixture.example',
  getPassword: () => 'fixture-only',
});
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ status, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const boundary = {
  provider: 'imessage',
  providerEpoch,
  ledgerEpoch,
  checkpoint: 'signed-cursor',
  sequence: '9007199254740993',
};
beforeEach(() => mockKy.mockReset());
it('uses the existing authenticated POST boundary and exact versioned cursor', async () => {
  mockKy.mockResolvedValue(
    response({
      version: 1,
      provider: 'imessage',
      providerEpoch,
      ledgerEpoch,
      events: [],
      cursor: 'signed-cursor',
      hasMore: false,
      prunedThrough: '0',
      sequence: '10',
      boundary: '10',
    }),
  );
  await messageStateApi.page(client, 'previous-cursor');
  expect(mockKy.mock.calls[0][1].json).toEqual({
    version: 1,
    provider: 'imessage',
    cursor: 'previous-cursor',
  });
  expect(mockKy.mock.calls[0][1].method).toBe('POST');
});
it('binds provider repair begin and finish to the explicit sequence and context', async () => {
  mockKy.mockResolvedValueOnce(
    response({
      version: 2,
      action: 'begin',
      token: providerEpoch,
      expiresAt: 2_000_000_000_000,
      ...boundary,
    }),
  );
  const lease = await repairApi.beginProvider(client);
  expect(lease.sequence).toBe('9007199254740993');
  expect(mockKy.mock.calls[0][1].json).toEqual({
    action: 'begin',
    version: 2,
    provider: 'imessage',
  });
  mockKy.mockResolvedValueOnce(
    response({ version: 2, action: 'finish', stable: true, ...boundary }),
  );
  await expect(repairApi.finishProvider(client, lease.token)).resolves.toMatchObject(boundary);
  expect(mockKy.mock.calls[1][1].json).toEqual({
    action: 'finish',
    version: 2,
    provider: 'imessage',
    token: providerEpoch,
  });
});
it('keeps exact restore identifiers in the request body rather than the URL', async () => {
  mockKy.mockResolvedValue(
    response({ message: { guid: 'a/b?c', chats: [{ guid: 'SMS;-;fixture' }] } }),
  );
  await messageStateApi.activeMessage(client, 'a/b?c', providerEpoch);
  expect(String(mockKy.mock.calls[0][0])).toBe(
    'https://fixture.example/api/v1/sync/message-state/message',
  );
  expect(mockKy.mock.calls[0][1].json).toEqual({
    version: 1,
    provider: 'imessage',
    providerEpoch,
    guid: 'a/b?c',
  });
});
it('rejects overlarge or mixed-provider state payloads before returning a page', async () => {
  mockKy.mockResolvedValue(
    response({
      version: 1,
      provider: 'imessage',
      providerEpoch,
      ledgerEpoch,
      events: [
        { sequence: '11', kind: 'deleted', guid: 'rcs-foreign', chatGuid: null, dateDeleted: 123 },
      ],
      cursor: 'next',
      hasMore: false,
      prunedThrough: '0',
      sequence: '11',
      boundary: '11',
    }),
  );
  await expect(messageStateApi.page(client, 'previous')).rejects.toThrow();
});
