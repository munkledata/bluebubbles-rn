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
import { runOutgoingQueue } from '@/services/send/outgoingQueueService';
import {
  fixedRcsCapabilitySource,
  type RcsCapabilityLease,
} from '@/services/send/rcsAttemptCapability';
import { sendIMessageMention } from '@/services/send/sendMentionService';
import { createTestDb } from '../support/testDb';

const CHAT_GUID = 'iMessage;+;chat-mention-service';
const TEXT = 'Hello Alice and Bob';
const MENTIONS = [
  { start: 6, length: 5, address: 'alice@example.test' },
  { start: 16, length: 3, address: '+15551234567' },
];

function seedGroup(raw: Database.Database): void {
  const chat = raw.prepare('INSERT INTO chats(guid, style) VALUES (?, 43)').run(CHAT_GUID);
  for (const address of ['alice@example.test', '+15551234567']) {
    const handle = raw
      .prepare('INSERT INTO handles(address, service) VALUES (?, ?)')
      .run(address, 'iMessage');
    raw
      .prepare('INSERT INTO chat_handles(chat_id, handle_id) VALUES (?, ?)')
      .run(Number(chat.lastInsertRowid), Number(handle.lastInsertRowid));
  }
}

function capability(enabled = true) {
  return fixedRcsCapabilitySource(
    ServerInfo.parse({ version: 'test', supports_imessage_mentions: enabled }),
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
      origin: 'https://mention.test',
      headers: {},
      password: 'test',
      transportRevision: 1,
      buildUrl: (path: string) => `https://mention.test/api/v1${path}`,
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

describe('sendIMessageMention', () => {
  let db: AppDatabase;
  let raw: Database.Database;

  beforeEach(async () => {
    ({ db, raw } = await createTestDb());
    seedGroup(raw);
  });

  afterEach(() => raw.close());

  it('treats the mention flag as a live send-capability revision', () => {
    const disabled = ServerInfo.parse({ version: 'test', supports_imessage_mentions: false });
    const enabled = ServerInfo.parse({ version: 'test', supports_imessage_mentions: true });
    expect(serverSendCapabilityKey(enabled)).not.toBe(serverSendCapabilityKey(disabled));
  });

  it('admits one marked row, sends one exact request, blocks overlap, and promotes the helper GUID', async () => {
    const response = deferred<unknown>();
    const started = deferred<void>();
    const transport = fakeHttp(async () => {
      started.resolve();
      return response.promise;
    });
    const first = sendIMessageMention(
      db,
      transport.http,
      { chatGuid: CHAT_GUID, text: TEXT, mentions: MENTIONS },
      10_000,
      undefined,
      capability(),
    );
    await started.promise;

    const queued = one(raw, 'SELECT temp_guid AS tempGuid, payload FROM outgoing_queue');
    expect(JSON.parse(String(queued.payload))).toEqual({
      message: TEXT,
      imessageMentionV1: true,
      mentions: MENTIONS,
    });
    await expect(
      sendIMessageMention(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, text: 'Hello Alice', mentions: [MENTIONS[0]!] },
        10_001,
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post.mock.calls[0]).toEqual([
      '/message/mention',
      expect.anything(),
      {
        captureErrorDetail: true,
        retry: false,
        json: {
          chatGuid: CHAT_GUID,
          tempGuid: queued.tempGuid,
          message: TEXT,
          mentions: MENTIONS,
        },
      },
    ]);

    response.resolve({ guid: 'real-mention-guid', viaPrivateApi: true });
    await expect(first).resolves.toEqual({ status: 'accepted', tempGuid: queued.tempGuid });
    expect(
      one(raw, 'SELECT guid, text, send_state AS state FROM messages WHERE date_deleted IS NULL'),
    ).toEqual({ guid: 'real-mention-guid', text: TEXT, state: 'sent' });
    expect(one(raw, 'SELECT COUNT(*) AS count FROM outgoing_queue').count).toBe(0);
  });

  it('fails closed before HTTP without the live capability, exact group, or exact participant', async () => {
    const transport = fakeHttp(async () => ({ guid: 'must-not-send', viaPrivateApi: true }));

    await expect(
      sendIMessageMention(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, text: TEXT, mentions: MENTIONS },
        10_000,
        undefined,
        capability(false),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    await expect(
      sendIMessageMention(
        db,
        transport.http,
        {
          chatGuid: CHAT_GUID,
          text: 'Hello Mallory',
          mentions: [{ start: 6, length: 7, address: 'mallory@example.test' }],
        },
        10_000,
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });

    raw.prepare("UPDATE handles SET service = 'SMS' WHERE address = 'alice@example.test'").run();
    await expect(
      sendIMessageMention(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, text: TEXT, mentions: MENTIONS },
        10_000,
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });

    raw
      .prepare(
        "UPDATE handles SET address = ' alice@example.test', service = 'iMessage' WHERE address = 'alice@example.test'",
      )
      .run();
    await expect(
      sendIMessageMention(
        db,
        transport.http,
        {
          chatGuid: CHAT_GUID,
          text: 'Hello Bob',
          mentions: [{ start: 6, length: 3, address: '+15551234567' }],
        },
        10_000,
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });

    raw
      .prepare(
        "UPDATE handles SET address = 'alice@example.test' WHERE address = ' alice@example.test'",
      )
      .run();
    raw.prepare('UPDATE chats SET style = 45 WHERE guid = ?').run(CHAT_GUID);
    await expect(
      sendIMessageMention(
        db,
        transport.http,
        {
          chatGuid: CHAT_GUID,
          text: 'Hello Bob',
          mentions: [{ start: 6, length: 3, address: '+15551234567' }],
        },
        10_000,
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).not.toHaveBeenCalled();
    expect(one(raw, 'SELECT COUNT(*) AS count FROM messages').count).toBe(0);
    expect(one(raw, 'SELECT COUNT(*) AS count FROM outgoing_queue').count).toBe(0);
  });

  it.each([
    [409, 'imessage_mention_rejected'],
    [503, 'idempotency_capacity_exhausted'],
    [503, 'idempotency_persistence_unavailable'],
  ])(
    'discards a definite pre-dispatch failure %s/%s only while its guards remain current',
    async (status, errorType) => {
      const transport = fakeHttp(async () => {
        throw ApiError.fromStatus(status, 'rejected', undefined, errorType);
      });

      const result = await sendIMessageMention(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, text: TEXT, mentions: MENTIONS },
        10_000,
        undefined,
        capability(),
      );

      expect(result.status).toBe('rejected');
      expect(transport.post).toHaveBeenCalledTimes(1);
      expect(one(raw, 'SELECT date_deleted AS deleted FROM messages').deleted).toBe(10_000);
      expect(one(raw, 'SELECT COUNT(*) AS count FROM outgoing_queue').count).toBe(0);
    },
  );

  it.each([
    [
      'a malformed acknowledgement',
      async () => ({ guid: 'real-but-unproven', viaPrivateApi: false }),
    ],
    [
      'an uncertain transport failure',
      async () => {
        throw new Error('connection ended after request write');
      },
    ],
    [
      'a reused idempotency key',
      async () => {
        throw ApiError.fromStatus(409, 'key reused', undefined, 'idempotency_key_reused');
      },
    ],
  ])('retires %s as terminal outcome-unknown', async (_label, postResult) => {
    const transport = fakeHttp(postResult);

    const result = await sendIMessageMention(
      db,
      transport.http,
      { chatGuid: CHAT_GUID, text: TEXT, mentions: MENTIONS },
      10_000,
      undefined,
      capability(),
    );

    expect(result).toMatchObject({ status: 'outcome-unknown', tempGuid: expect.any(String) });
    expect(
      one(raw, `SELECT send_state AS state, error FROM messages WHERE guid = '${result.tempGuid}'`),
    ).toEqual({ state: 'error', error: ClientErrorCode.mentionDeliveryUnconfirmed });
    expect(one(raw, 'SELECT attempts FROM outgoing_queue').attempts).toBe(OUTGOING_MAX_ATTEMPTS);
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('retires a late acknowledgement as outcome-unknown after capability ownership changes', async () => {
    const response = deferred<unknown>();
    const started = deferred<void>();
    const transport = fakeHttp(async () => {
      started.resolve();
      return response.promise;
    });
    let current = true;
    const source: RcsCapabilityLease = {
      kind: 'session',
      origin: 'https://mention.test',
      revision: 1,
      serverInfo: ServerInfo.parse({ version: 'test', supports_imessage_mentions: true }),
      isCurrent: () => current,
      publish: () => false,
    };
    const pending = sendIMessageMention(
      db,
      transport.http,
      { chatGuid: CHAT_GUID, text: TEXT, mentions: MENTIONS },
      10_000,
      undefined,
      source,
    );
    await started.promise;
    current = false;
    response.resolve({ guid: 'must-not-promote', viaPrivateApi: true });

    const result = await pending;
    expect(result).toMatchObject({ status: 'outcome-unknown', tempGuid: expect.any(String) });
    expect(
      one(raw, `SELECT send_state AS state, error FROM messages WHERE guid = '${result.tempGuid}'`),
    ).toEqual({ state: 'error', error: ClientErrorCode.mentionDeliveryUnconfirmed });
    expect(one(raw, 'SELECT attempts FROM outgoing_queue').attempts).toBe(OUTGOING_MAX_ATTEMPTS);
    expect(
      one(raw, "SELECT COUNT(*) AS count FROM messages WHERE guid = 'must-not-promote'").count,
    ).toBe(0);
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('returns outcome-unknown without a stale DB write when the account retires after dispatch', async () => {
    const response = deferred<unknown>();
    const started = deferred<void>();
    const transport = fakeHttp(async () => {
      started.resolve();
      return response.promise;
    });
    let accountCurrent = true;
    const pending = sendIMessageMention(
      db,
      transport.http,
      { chatGuid: CHAT_GUID, text: TEXT, mentions: MENTIONS },
      10_000,
      () => accountCurrent,
      capability(),
    );
    await started.promise;
    accountCurrent = false;
    response.resolve({ guid: 'must-not-cross-account', viaPrivateApi: true });

    const result = await pending;
    expect(result).toMatchObject({ status: 'outcome-unknown', tempGuid: expect.any(String) });
    expect(
      one(raw, `SELECT send_state AS state FROM messages WHERE guid = '${result.tempGuid}'`),
    ).toEqual({ state: 'sending' });
    expect(one(raw, 'SELECT attempts FROM outgoing_queue').attempts).toBe(0);
    expect(
      one(raw, "SELECT COUNT(*) AS count FROM messages WHERE guid = 'must-not-cross-account'")
        .count,
    ).toBe(0);
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('never manually or automatically replays a recovered imessageMentionV1 row as plain text', async () => {
    await insertOutgoingText(db, {
      tempGuid: 'temp-mention-recovery',
      chatGuid: CHAT_GUID,
      text: TEXT,
      mentions: MENTIONS,
      oneShotMention: true,
      now: 1_000,
    });
    raw
      .prepare(
        `UPDATE messages SET send_state = 'error', error = 500
          WHERE guid = 'temp-mention-recovery'`,
      )
      .run();

    await expect(claimFailedOutgoingForRetry(db, 'temp-mention-recovery')).resolves.toEqual({
      claim: 'unsendable',
    });
    expect(one(raw, 'SELECT attempts FROM outgoing_queue').attempts).toBe(0);

    raw
      .prepare(
        `UPDATE messages SET send_state = 'sending', error = 0
          WHERE guid = 'temp-mention-recovery'`,
      )
      .run();
    raw
      .prepare(
        `UPDATE outgoing_queue SET created_at = 0, next_retry_at = 0
          WHERE temp_guid = 'temp-mention-recovery'`,
      )
      .run();
    const transport = fakeHttp(async () => {
      throw new Error('a marked mention must never reach HTTP recovery');
    });
    await expect(
      runOutgoingQueue(
        db,
        transport.http,
        {
          fileExists: async () => false,
          upload: async () => {
            throw new Error('a mention recovery must never upload');
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
           FROM messages WHERE guid = 'temp-mention-recovery'`,
      ),
    ).toEqual({
      state: 'error',
      error: ClientErrorCode.mentionDeliveryUnconfirmed,
      detail:
        'This mention message may have been delivered. Check Messages before sending a new copy.',
    });
  });
});
