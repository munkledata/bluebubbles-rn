import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient, RequestOptions } from '@core/api/http';
import { ServerInfo, serverSendCapabilityKey } from '@core/models';
import {
  claimFailedOutgoingForRetry,
  insertOutgoingText,
  OUTGOING_MAX_ATTEMPTS,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { ClientErrorCode } from '@utils';
import { fixedRcsCapabilitySource } from '@/services/send/rcsAttemptCapability';
import { sendIMessageFormatted } from '@/services/send/sendFormattedService';
import { runOutgoingQueue } from '@/services/send/outgoingQueueService';
import { createTestDb } from '../support/testDb';

const CHAT_GUID = 'iMessage;-;+15551234567';
const TEXT = 'Hello world';
const FORMATTING = [
  { start: 0, length: 5, styles: ['bold'] as 'bold'[] },
  { start: 6, length: 5, styles: ['italic', 'underline'] as ('italic' | 'underline')[] },
];

function seedOneToOne(raw: Database.Database): void {
  const chat = raw.prepare('INSERT INTO chats(guid, style) VALUES (?, 45)').run(CHAT_GUID);
  const handle = raw
    .prepare('INSERT INTO handles(address, service) VALUES (?, ?)')
    .run('+15551234567', 'iMessage');
  raw
    .prepare('INSERT INTO chat_handles(chat_id, handle_id) VALUES (?, ?)')
    .run(Number(chat.lastInsertRowid), Number(handle.lastInsertRowid));
}

function capability(enabled = true) {
  return fixedRcsCapabilitySource(
    ServerInfo.parse({ version: 'test', supports_imessage_formatted_messages: enabled }),
  );
}

function fakeHttp(impl: (options: RequestOptions) => Promise<unknown>): {
  http: HttpClient;
  post: jest.Mock;
} {
  const post = jest.fn((_path: string, _schema: unknown, options: RequestOptions) => impl(options));
  let http!: HttpClient;
  http = {
    post,
    pinTransport: () => http,
    isTransportCurrent: () => true,
    snapshotTransport: () => ({
      origin: 'https://formatted.test',
      headers: {},
      password: 'test',
      transportRevision: 1,
      buildUrl: (path: string) => `https://formatted.test/api/v1${path}`,
    }),
  } as unknown as HttpClient;
  return { http, post };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function one(raw: Database.Database, sql: string): Record<string, unknown> {
  return raw.prepare(sql).get() as Record<string, unknown>;
}

describe('sendIMessageFormatted', () => {
  let db: AppDatabase;
  let raw: Database.Database;

  beforeEach(async () => {
    ({ db, raw } = await createTestDb());
    seedOneToOne(raw);
  });

  afterEach(() => raw.close());

  it('treats formatted-message support as a live send-capability revision', () => {
    const disabled = ServerInfo.parse({
      version: 'test',
      supports_imessage_formatted_messages: false,
    });
    const enabled = ServerInfo.parse({
      version: 'test',
      supports_imessage_formatted_messages: true,
    });
    expect(serverSendCapabilityKey(enabled)).not.toBe(serverSendCapabilityKey(disabled));
  });

  it('persists a marked optimistic body, sends once, and promotes the helper GUID', async () => {
    const response = deferred<unknown>();
    const started = deferred<void>();
    const transport = fakeHttp(async () => {
      started.resolve();
      return response.promise;
    });

    const send = sendIMessageFormatted(
      db,
      transport.http,
      { chatGuid: CHAT_GUID, text: TEXT, textFormatting: FORMATTING },
      10_000,
      undefined,
      capability(),
    );
    await started.promise;

    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post.mock.calls[0]?.[0]).toBe('/message/formatted');
    const payload = JSON.parse(String(one(raw, 'SELECT payload FROM outgoing_queue').payload));
    expect(payload).toEqual({
      message: TEXT,
      imessageFormattedV1: true,
      textFormatting: FORMATTING,
    });
    response.resolve({ guid: 'real-formatted-guid', viaPrivateApi: true });
    await expect(send).resolves.toMatchObject({ status: 'accepted' });
    const message = one(
      raw,
      'SELECT guid, text, attributed_body AS attributedBody, send_state AS state FROM messages',
    );
    expect(message.guid).toBe('real-formatted-guid');
    expect(message.text).toBe(TEXT);
    expect(message.state).toBe('sent');
    expect(JSON.parse(String(message.attributedBody))[0].runs).toHaveLength(2);
  });

  it('fails closed without capability and permanently marks an ambiguous dispatch', async () => {
    const unavailable = fakeHttp(async () => ({ guid: 'must-not-send', viaPrivateApi: true }));
    await expect(
      sendIMessageFormatted(
        db,
        unavailable.http,
        { chatGuid: CHAT_GUID, text: TEXT, textFormatting: FORMATTING },
        10_000,
        undefined,
        capability(false),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(unavailable.post).not.toHaveBeenCalled();

    const uncertain = fakeHttp(async () => {
      throw new ApiError('no_connection', 'connection ended');
    });
    await expect(
      sendIMessageFormatted(
        db,
        uncertain.http,
        { chatGuid: CHAT_GUID, text: TEXT, textFormatting: FORMATTING },
        10_001,
        undefined,
        capability(),
      ),
    ).resolves.toMatchObject({ status: 'outcome-unknown' });
    expect(
      one(raw, 'SELECT send_state AS state, error FROM messages WHERE date_deleted IS NULL'),
    ).toEqual({ state: 'error', error: ClientErrorCode.formattedDeliveryUnconfirmed });
    const queued = one(raw, 'SELECT payload FROM outgoing_queue');
    expect(JSON.parse(String(queued.payload))).toMatchObject({
      imessageFormattedV1: true,
      textFormatting: FORMATTING,
    });
  });

  it('never manually or automatically replays a recovered formatted row as plain text', async () => {
    await insertOutgoingText(db, {
      tempGuid: 'temp-formatted-recovery',
      chatGuid: CHAT_GUID,
      text: TEXT,
      textFormatting: FORMATTING,
      oneShotFormatted: true,
      now: 1_000,
    });
    raw
      .prepare(
        `UPDATE messages SET send_state = 'error', error = ?
          WHERE guid = 'temp-formatted-recovery'`,
      )
      .run(ClientErrorCode.clientError);

    await expect(claimFailedOutgoingForRetry(db, 'temp-formatted-recovery')).resolves.toEqual({
      claim: 'unsendable',
    });

    raw
      .prepare(
        `UPDATE messages SET send_state = 'sending', error = 0
          WHERE guid = 'temp-formatted-recovery'`,
      )
      .run();
    raw
      .prepare(
        `UPDATE outgoing_queue SET created_at = 0, next_retry_at = 0
          WHERE temp_guid = 'temp-formatted-recovery'`,
      )
      .run();
    const transport = fakeHttp(async () => {
      throw new Error('a marked formatted message must never reach HTTP recovery');
    });
    await expect(
      runOutgoingQueue(
        db,
        transport.http,
        {
          fileExists: async () => false,
          upload: async () => {
            throw new Error('formatted recovery must never upload');
          },
        },
        2_000_000,
      ),
    ).resolves.toEqual({ eligible: 1, sent: 0 });

    expect(transport.post).not.toHaveBeenCalled();
    expect(one(raw, 'SELECT attempts FROM outgoing_queue').attempts).toBe(OUTGOING_MAX_ATTEMPTS);
    expect(
      one(
        raw,
        `SELECT send_state AS state, error, error_message AS detail
           FROM messages WHERE guid = 'temp-formatted-recovery'`,
      ),
    ).toEqual({
      state: 'error',
      error: ClientErrorCode.formattedDeliveryUnconfirmed,
      detail:
        'This formatted message may have been delivered. Check Messages before sending a new copy.',
    });
  });
});
