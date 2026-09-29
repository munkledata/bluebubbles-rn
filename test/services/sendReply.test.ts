import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { Chat, Message, ServerInfo } from '@core/models';
import {
  claimFailedOutgoingForRetry,
  OUTGOING_MAX_ATTEMPTS,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { sendTextMessage } from '@/services/send/sendService';
import { fixedRcsCapabilitySource } from '@/services/send/rcsAttemptCapability';
import { ClientErrorCode } from '@utils';
import { createTestDb } from '../support/testDb';

const CHAT_GUID = 'any;-;+15551234567';

function fakeHttp(impl: (json?: unknown) => Promise<unknown>): {
  http: HttpClient;
  post: jest.Mock;
} {
  const post = jest.fn((_path: string, _schema: unknown, opts?: { json?: unknown }) =>
    impl(opts?.json),
  );
  let http!: HttpClient;
  http = {
    get: async () => ({ version: 'test' }),
    post,
    pinTransport: () => http,
    isTransportCurrent: () => true,
    assertTransportCurrent: () => undefined,
  } as unknown as HttpClient;
  return { http, post };
}

async function seedReplyTarget(
  db: AppDatabase,
  options: { service?: 'iMessage' | 'SMS'; style?: number } = {},
): Promise<void> {
  const participant = {
    address: '+15551234567',
    service: options.service ?? 'iMessage',
  };
  const handles = await upsertHandles(db, [participant]);
  const chats = await upsertChats(
    db,
    [Chat.parse({ guid: CHAT_GUID, style: options.style ?? 45, participants: [participant] })],
    handles,
  );
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: 'reply-target',
        text: 'original',
        dateCreated: 100,
        messagePartTopology: {
          complete: true,
          originalPartIndexes: [0],
          currentParts: [{ index: 0, kind: 'text' }],
          attachmentOwnership: [],
        },
      }),
    ],
    () => chats.get(CHAT_GUID)!,
    handles,
  );
}

const replyCapability = (enabled: boolean) =>
  fixedRcsCapabilitySource(
    ServerInfo.parse({ version: '2.0.0', supports_imessage_replies: enabled }),
  );

const one = (raw: Database.Database, sql: string, ...params: unknown[]) =>
  raw.prepare(sql).get(...params) as Record<string, unknown>;

describe('narrow one-to-one iMessage reply', () => {
  it.each([
    ['NUL', 'before\u0000after'],
    ['a lone UTF-16 surrogate', 'before\ud800after'],
  ])('rejects reply text containing %s before DB admission or HTTP', async (_label, text) => {
    const { db, raw } = await createTestDb();
    await seedReplyTarget(db);
    const transport = fakeHttp(async () => ({ guid: 'must-not-send', viaPrivateApi: true }));
    const onQueued = jest.fn();

    await expect(
      sendTextMessage(
        db,
        transport.http,
        {
          chatGuid: CHAT_GUID,
          text,
          selectedMessageGuid: 'reply-target',
          partIndex: 0,
        },
        1_000,
        onQueued,
        undefined,
        undefined,
        replyCapability(true),
      ),
    ).rejects.toThrow('must be nonblank, well-formed text without NUL');

    expect(onQueued).not.toHaveBeenCalled();
    expect(transport.post).not.toHaveBeenCalled();
    expect(one(raw, "SELECT COUNT(*) AS count FROM messages WHERE guid LIKE 'temp-%'")).toEqual({
      count: 0,
    });
    expect(one(raw, 'SELECT COUNT(*) AS count FROM outgoing_queue')).toEqual({ count: 0 });
  });

  it('fails before DB or HTTP when the exact reply capability is absent', async () => {
    const { db, raw } = await createTestDb();
    await seedReplyTarget(db);
    const transport = fakeHttp(async () => ({ guid: 'must-not-send', viaPrivateApi: true }));

    await expect(
      sendTextMessage(
        db,
        transport.http,
        {
          chatGuid: CHAT_GUID,
          text: 'must stay local',
          selectedMessageGuid: 'reply-target',
          partIndex: 0,
        },
        1_000,
        undefined,
        undefined,
        undefined,
        replyCapability(false),
      ),
    ).rejects.toThrow('cannot send iMessage replies');

    expect(transport.post).not.toHaveBeenCalled();
    expect(one(raw, "SELECT COUNT(*) AS count FROM messages WHERE guid LIKE 'temp-%'")).toEqual({
      count: 0,
    });
    expect(one(raw, 'SELECT COUNT(*) AS count FROM outgoing_queue')).toEqual({ count: 0 });
  });

  it('posts only the exact part-zero target and preserves its local thread originator', async () => {
    const { db, raw } = await createTestDb();
    await seedReplyTarget(db);
    let body: Record<string, unknown> | undefined;
    const transport = fakeHttp(async (json) => {
      body = json as Record<string, unknown>;
      return { guid: 'real-reply', viaPrivateApi: true };
    });

    await sendTextMessage(
      db,
      transport.http,
      {
        chatGuid: CHAT_GUID,
        text: 'Yes',
        selectedMessageGuid: 'reply-target',
        partIndex: 0,
      },
      1_000,
      undefined,
      undefined,
      undefined,
      replyCapability(true),
    );

    expect(body).toEqual(
      expect.objectContaining({
        chatGuid: CHAT_GUID,
        text: 'Yes',
        selectedMessageGuid: 'reply-target',
        partIndex: 0,
      }),
    );
    expect(body).not.toHaveProperty('method');
    expect(
      one(
        raw,
        "SELECT send_state AS state, thread_originator_guid AS target FROM messages WHERE guid='real-reply'",
      ),
    ).toEqual({ state: 'sent', target: 'reply-target' });
    expect(one(raw, 'SELECT COUNT(*) AS count FROM outgoing_queue')).toEqual({ count: 0 });
  });

  it('treats a target-equal helper acknowledgement as uncertain instead of collapsing the reply', async () => {
    const { db, raw } = await createTestDb();
    await seedReplyTarget(db);
    const transport = fakeHttp(async () => ({ guid: 'reply-target', viaPrivateApi: true }));

    const result = await sendTextMessage(
      db,
      transport.http,
      {
        chatGuid: CHAT_GUID,
        text: 'one attempt only',
        selectedMessageGuid: 'reply-target',
        partIndex: 0,
      },
      1_000,
      undefined,
      undefined,
      undefined,
      replyCapability(true),
    );

    expect(one(raw, "SELECT COUNT(*) AS count FROM messages WHERE guid='reply-target'")).toEqual({
      count: 1,
    });
    expect(one(raw, 'SELECT error AS code FROM messages WHERE guid=?', result.tempGuid)).toEqual({
      code: ClientErrorCode.replyDeliveryUnconfirmed,
    });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('rejects nonzero parts and unproven group chats before queue admission', async () => {
    const partDb = await createTestDb();
    await seedReplyTarget(partDb.db);
    const partTransport = fakeHttp(async () => ({ guid: 'must-not-send', viaPrivateApi: true }));
    await expect(
      sendTextMessage(
        partDb.db,
        partTransport.http,
        {
          chatGuid: CHAT_GUID,
          text: 'wrong part',
          selectedMessageGuid: 'reply-target',
          partIndex: 1,
        },
        1_000,
        undefined,
        undefined,
        undefined,
        replyCapability(true),
      ),
    ).rejects.toThrow('exact message part zero');
    expect(partTransport.post).not.toHaveBeenCalled();

    const groupDb = await createTestDb();
    await seedReplyTarget(groupDb.db, { style: 43 });
    const groupTransport = fakeHttp(async () => ({ guid: 'must-not-send', viaPrivateApi: true }));
    await expect(
      sendTextMessage(
        groupDb.db,
        groupTransport.http,
        {
          chatGuid: CHAT_GUID,
          text: 'wrong chat',
          selectedMessageGuid: 'reply-target',
          partIndex: 0,
        },
        1_000,
        undefined,
        undefined,
        undefined,
        replyCapability(true),
      ),
    ).rejects.toThrow('proven existing one-to-one iMessage chat');
    expect(groupTransport.post).not.toHaveBeenCalled();
  });

  it('retires an uncertain reply permanently instead of retrying it', async () => {
    const { db, raw } = await createTestDb();
    await seedReplyTarget(db);
    const transport = fakeHttp(async () => {
      throw ApiError.fromStatus(
        409,
        'helper acknowledgement was lost',
        undefined,
        'idempotency_outcome_unknown',
      );
    });

    const result = await sendTextMessage(
      db,
      transport.http,
      {
        chatGuid: CHAT_GUID,
        text: 'one attempt only',
        selectedMessageGuid: 'reply-target',
        partIndex: 0,
      },
      1_000,
      undefined,
      undefined,
      undefined,
      replyCapability(true),
    );

    expect(
      one(
        raw,
        'SELECT error AS code, attempts FROM messages JOIN outgoing_queue ON temp_guid=guid',
      ),
    ).toEqual({ code: ClientErrorCode.replyDeliveryUnconfirmed, attempts: OUTGOING_MAX_ATTEMPTS });
    await expect(claimFailedOutgoingForRetry(db, result.tempGuid)).resolves.toMatchObject({
      claim: 'unsendable',
    });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });
});
