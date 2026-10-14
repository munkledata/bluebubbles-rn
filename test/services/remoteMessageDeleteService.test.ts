import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient, RequestOptions } from '@core/api/http';
import { ServerInfo } from '@core/models';
import type { AppDatabase } from '@db/types';
import { remoteDeleteExactIMessage } from '@/services/remoteMessageDeleteService';
import { fixedRcsCapabilitySource } from '@/services/send/rcsAttemptCapability';
import { createTestDb } from '../support/testDb';

const DM_GUID = 'iMessage;-;+15551234567';
const GROUP_GUID = 'iMessage;+;chat123456789';
const MESSAGE_GUID = 'message-delete-1';

function seedChatAndMessage(raw: Database.Database, chatGuid: string, style: 43 | 45): void {
  const chat = raw.prepare('INSERT INTO chats(guid, style) VALUES (?, ?)').run(chatGuid, style);
  const addresses = style === 43 ? ['+15550000001', '+15550000002'] : ['+15550000001'];
  for (const address of addresses) {
    const handle = raw
      .prepare('INSERT INTO handles(address, service) VALUES (?, ?)')
      .run(address, 'iMessage');
    raw
      .prepare('INSERT INTO chat_handles(chat_id, handle_id) VALUES (?, ?)')
      .run(Number(chat.lastInsertRowid), Number(handle.lastInsertRowid));
  }
  raw
    .prepare(
      `INSERT INTO messages(guid, chat_id, text, is_from_me, date_created, send_state)
       VALUES (?, ?, 'delete me', 1, 100, 'sent')`,
    )
    .run(MESSAGE_GUID, Number(chat.lastInsertRowid));
}

function capability(enabled = true) {
  return fixedRcsCapabilitySource(
    ServerInfo.parse({ version: 'test', supports_imessage_remote_delete: enabled }),
  );
}

function fakeHttp(impl: (path: string, options: RequestOptions) => Promise<unknown>): {
  http: HttpClient;
  post: jest.Mock;
} {
  const post = jest.fn(async (path: string, schema: { parse(value: unknown): unknown }, options) =>
    schema.parse(await impl(path, options)),
  );
  let http!: HttpClient;
  http = {
    post,
    pinTransport: () => http,
    isTransportCurrent: () => true,
    snapshotTransport: () => ({
      origin: 'https://remote-delete.test',
      headers: {},
      password: 'test',
      transportRevision: 1,
      buildUrl: (path: string) => `https://remote-delete.test/api/v1${path}`,
    }),
  } as unknown as HttpClient;
  return { http, post };
}

describe('whole-message remote deletion', () => {
  let db: AppDatabase;
  let raw: Database.Database;

  beforeEach(async () => {
    ({ db, raw } = await createTestDb());
  });

  afterEach(() => raw.close());

  it.each([
    ['one-to-one', DM_GUID, 45 as const],
    ['group', GROUP_GUID, 43 as const],
  ])(
    'accepts one exact %s target, sends no part index, then tombstones it locally',
    async (_kind, chatGuid, style) => {
      seedChatAndMessage(raw, chatGuid, style);
      const transport = fakeHttp(async () => ({ deleted: true, guid: MESSAGE_GUID }));

      await expect(
        remoteDeleteExactIMessage(
          db,
          transport.http,
          { chatGuid, messageGuid: MESSAGE_GUID },
          6_000,
          undefined,
          capability(),
        ),
      ).resolves.toEqual({ status: 'accepted' });

      expect(transport.post).toHaveBeenCalledTimes(1);
      expect(transport.post.mock.calls[0]).toEqual([
        '/message/message-delete-1/remote-delete',
        expect.anything(),
        {
          captureErrorDetail: true,
          retry: false,
          json: { chatGuid },
        },
      ]);
      expect(transport.post.mock.calls[0]?.[2]?.json).not.toHaveProperty('partIndex');
      expect(
        raw.prepare('SELECT date_deleted FROM messages WHERE guid = ?').get(MESSAGE_GUID),
      ).toEqual({ date_deleted: 6_000 });
    },
  );

  it('reports a deletion the Mac confirmed even when the connection changed meanwhile', async () => {
    seedChatAndMessage(raw, DM_GUID, 45);
    let transportCurrent = true;
    const transport = fakeHttp(async () => {
      // The server address or password is replaced while the confirmed request is in flight.
      transportCurrent = false;
      return { deleted: true, guid: MESSAGE_GUID };
    });
    (transport.http as unknown as { isTransportCurrent: () => boolean }).isTransportCurrent = () =>
      transportCurrent;

    await expect(
      remoteDeleteExactIMessage(
        db,
        transport.http,
        { chatGuid: DM_GUID, messageGuid: MESSAGE_GUID },
        6_000,
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'accepted' });
    // No local write under a changed connection; the Mac's deletion reaches the phone by sync.
    expect(
      raw.prepare('SELECT date_deleted FROM messages WHERE guid = ?').get(MESSAGE_GUID),
    ).toEqual({ date_deleted: null });
  });

  it('leaves the phone row visible after one definite server refusal', async () => {
    seedChatAndMessage(raw, DM_GUID, 45);
    const transport = fakeHttp(async () => {
      throw ApiError.fromStatus(409, 'not deleted', undefined, 'imessage_remote_delete_rejected');
    });

    await expect(
      remoteDeleteExactIMessage(
        db,
        transport.http,
        { chatGuid: DM_GUID, messageGuid: MESSAGE_GUID },
        6_000,
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(
      raw.prepare('SELECT date_deleted FROM messages WHERE guid = ?').get(MESSAGE_GUID),
    ).toEqual({ date_deleted: null });
  });

  it('treats a malformed or mismatched acknowledgement as unknown without retry or tombstone', async () => {
    seedChatAndMessage(raw, DM_GUID, 45);
    const transport = fakeHttp(async () => ({ deleted: true, guid: 'another-message' }));

    await expect(
      remoteDeleteExactIMessage(
        db,
        transport.http,
        { chatGuid: DM_GUID, messageGuid: MESSAGE_GUID },
        6_000,
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'outcome-unknown' });
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(
      raw.prepare('SELECT date_deleted FROM messages WHERE guid = ?').get(MESSAGE_GUID),
    ).toEqual({ date_deleted: null });
  });

  it('rejects unsupported identities and missing capability before HTTP', async () => {
    seedChatAndMessage(raw, DM_GUID, 45);
    const transport = fakeHttp(async () => ({ deleted: true, guid: MESSAGE_GUID }));

    await expect(
      remoteDeleteExactIMessage(
        db,
        transport.http,
        { chatGuid: DM_GUID, messageGuid: `temp-${MESSAGE_GUID}` },
        6_000,
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    await expect(
      remoteDeleteExactIMessage(
        db,
        transport.http,
        { chatGuid: DM_GUID, messageGuid: `message-\u0085delete` },
        6_000,
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    await expect(
      remoteDeleteExactIMessage(
        db,
        transport.http,
        { chatGuid: DM_GUID, messageGuid: 'rcs-g1.example' },
        6_000,
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    await expect(
      remoteDeleteExactIMessage(
        db,
        transport.http,
        { chatGuid: DM_GUID, messageGuid: MESSAGE_GUID },
        6_000,
        undefined,
        capability(false),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).not.toHaveBeenCalled();
  });
});
