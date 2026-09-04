import { createHash } from 'node:crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod/v4';
import type { HttpClient } from '@core/api/http';
import {
  DeletedMessageList,
  MessageList,
  SERVER_MESSAGE_SEARCH_LIMIT,
  ServerMessageSearchList,
  SendAck,
  UnsendAck,
  deletedMessages,
  queryMessages,
  searchMessagesOnServer,
  sendText,
  unsendMessage,
} from '@core/api/endpoints/messages';
import { ChatList, createChat, getChat, queryChats } from '@core/api/endpoints/chats';
import { answerFaceTime, createFaceTimeLink, leaveFaceTime } from '@core/api/endpoints/facetime';
import { registerDevice } from '@core/api/endpoints/fcm';
import { SYNC_WITH_QUERY } from '@core/config/constants';

/**
 * Endpoint-shape contract gate. The entity-level wire contract (wireContract.test.ts)
 * only proved the app models the server's ENTITIES; it missed the wrapper layer — Gator
 * wraps responses in named keys ({ chats }, { messages }) and returns status/ack objects
 * ({ guid, viaPrivateApi }, { unsent }, { answered }, { id }) rather than bare entities.
 * These goldens mirror the actual `bbd/src/api/operations/*` + MessageSender returns
 * (post {status,message,data} unwrap), so a wrapper/ack divergence the app doesn't model
 * fails CI here instead of shipping (as it did before this audit).
 */
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', 'contract', 'v1', name), 'utf8'),
  );
}

const DELETED_MESSAGES_CONTINUED_FIXTURE_SHA256 =
  '15fa0d3eaa7a8c9fa5394cc50878e89b1be33398b73ca2a7828ec948c0254c62';
const DELETED_MESSAGES_LEDGER_FIXTURE_SHA256 =
  '571976a9840ac317cd6bd28b15b605fe62fc099c846dd582389cb7b203b01312';

function pinnedFixture(name: string, expectedSha256: string): unknown {
  const bytes = readFileSync(join(__dirname, '..', 'fixtures', 'contract', 'v1', name));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedSha256);
  return JSON.parse(bytes.toString('utf8'));
}

/** A fake HttpClient that ignores path/schema and returns the given pre-parsed payload,
 *  but still runs it through the endpoint's schema (so a schema mismatch throws). */
function httpReturning(payload: unknown): HttpClient {
  const respond = (_path: string, schema: z.ZodType) => schema.parseAsync(payload);
  return {
    get: respond,
    post: respond,
    put: respond,
    delete: respond,
  } as unknown as HttpClient;
}

describe('endpoint shapes: list wrappers', () => {
  it('queryChats reads the { chats: [...] } wrapper (not a bare array)', async () => {
    const parsed = ChatList.safeParse(fixture('chatList.gator.json'));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.chats).toHaveLength(1);
      expect(parsed.data.chats?.[0]?.guid).toBe('iMessage;-;+15551234567');
    }
    // ...and the endpoint unwraps it to a bare Chat[].
    const chats = await queryChats(httpReturning(fixture('chatList.gator.json')));
    expect(chats).toHaveLength(1);
    expect(chats[0]?.guid).toBe('iMessage;-;+15551234567');
  });

  it('queryMessages requests the shared sync projection and parses its metadata', async () => {
    const parsed = MessageList.safeParse(fixture('messageList.gator.json'));
    expect(parsed.success).toBe(true);
    const expectedProjection = [
      'chats',
      'chats.participants',
      'handle',
      'attachments',
      'attributedBody',
      'messageSummaryInfo',
      'payloadData',
    ] as const;
    expect(SYNC_WITH_QUERY).toEqual(expectedProjection);

    const response = {
      messages: [
        {
          guid: 'projection-message',
          text: 'after',
          messageSummaryInfo: {
            editedParts: {
              '0': [
                { date: 100, text: 'before' },
                { date: 200, text: 'after' },
              ],
            },
            retractedParts: [1],
          },
          payloadData: {
            urlData: [{ url: 'https://example.com/page', title: 'Projection title' }],
          },
        },
      ],
    };
    let request: { path: string; json: unknown } | undefined;
    const http = {
      post: async (path: string, schema: z.ZodType, options?: { json?: unknown }) => {
        request = { path, json: options?.json };
        return schema.parseAsync(response);
      },
    } as unknown as HttpClient;

    const projectionJoin = jest.spyOn(SYNC_WITH_QUERY, 'join');
    try {
      const msgs = await queryMessages(http, {
        limit: 37,
        afterTimestamp: 1_234,
        afterRowId: 5_678,
      });

      expect(projectionJoin).toHaveBeenCalledWith(',');
      expect(request).toEqual({
        path: '/message/query',
        json: {
          limit: 37,
          after: 1_234,
          afterRowId: 5_678,
          with: expectedProjection.join(','),
          sort: 'ASC',
        },
      });
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.guid).toBe('projection-message');
      expect(msgs[0]?.messageSummaryInfo?.editedParts?.['0']?.[1]?.text).toBe('after');
      expect(msgs[0]?.messageSummaryInfo?.retractedParts).toEqual([1]);
      expect(msgs[0]?.payloadData?.urlData?.[0]?.title).toBe('Projection title');
    } finally {
      projectionJoin.mockRestore();
    }
  });

  it('list wrappers tolerate an absent/null key (empty list)', () => {
    expect(ChatList.safeParse({}).success).toBe(true);
    expect(MessageList.safeParse({ messages: null }).success).toBe(true);
  });

  it('global Mac search uses the additive fixed-page route and rejects an oversized response', async () => {
    const payload = {
      messages: [
        {
          guid: 'remote-message',
          text: 'find this',
          chats: [{ guid: 'iMessage;-;remote-chat' }],
          handle: null,
        },
      ],
    };
    let request: { path: string; options: unknown } | undefined;
    const http = {
      post: async (path: string, schema: z.ZodType, options?: unknown) => {
        request = { path, options };
        return schema.parseAsync(payload);
      },
    } as unknown as HttpClient;

    const messages = await searchMessagesOnServer(http, 'find this');
    expect(messages.map((message) => message.guid)).toEqual(['remote-message']);
    expect(request).toEqual({
      path: '/message/search/bounded',
      options: {
        signal: undefined,
        retry: false,
        json: { text: 'find this', limit: SERVER_MESSAGE_SEARCH_LIMIT },
      },
    });
    expect(
      ServerMessageSearchList.safeParse({
        messages: Array.from(
          { length: SERVER_MESSAGE_SEARCH_LIMIT + 1 },
          () => payload.messages[0],
        ),
      }).success,
    ).toBe(false);
  });

  it('consumes both digest-locked cursor fixtures while retaining the old-server fallback', async () => {
    const continuedV1Fixture = DeletedMessageList.parse(
      pinnedFixture(
        'deletedMessages.continued.gator.json',
        DELETED_MESSAGES_CONTINUED_FIXTURE_SHA256,
      ),
    );
    const ledgerFixture = DeletedMessageList.parse(
      pinnedFixture('deletedMessages.ledger.gator.json', DELETED_MESSAGES_LEDGER_FIXTURE_SHA256),
    );
    if (
      typeof continuedV1Fixture.cursor !== 'string' ||
      typeof continuedV1Fixture.hasMore !== 'boolean' ||
      typeof ledgerFixture.cursor !== 'string' ||
      typeof ledgerFixture.hasMore !== 'boolean'
    ) {
      throw new Error('deletion cursor fixtures must contain cursor metadata');
    }
    expect(continuedV1Fixture.cursor).toMatch(/^v1\./);
    expect(ledgerFixture.cursor).toMatch(/^v2\./);
    const responses: unknown[] = [
      ledgerFixture,
      { deleted: [{ guid: 'legacy-deleted', chatGuid: null, dateDeleted: 1234 }] },
    ];
    const requests: { path: string; query: unknown }[] = [];
    const http = {
      get: async (
        path: string,
        schema: typeof DeletedMessageList,
        options?: { query?: unknown },
      ) => {
        requests.push({ path, query: options?.query });
        return schema.parseAsync(responses.shift());
      },
    } as unknown as HttpClient;

    const first = await deletedMessages(http, { afterMs: 1000, cursor: null });
    const second = await deletedMessages(http, {
      afterMs: 1234,
      cursor: continuedV1Fixture.cursor,
    });

    expect(first).toEqual({
      protocol: 'continuation',
      deleted: ledgerFixture.deleted,
      cursor: ledgerFixture.cursor,
      hasMore: ledgerFixture.hasMore,
    });
    expect(second).toEqual({
      protocol: 'legacy',
      deleted: [{ guid: 'legacy-deleted', chatGuid: null, dateDeleted: 1234 }],
    });
    expect(requests).toEqual([
      {
        path: '/message/deleted',
        query: { after: 1000, continuation: 1, cursor: undefined, ledger: 1 },
      },
      {
        path: '/message/deleted',
        query: {
          after: 1234,
          continuation: undefined,
          cursor: continuedV1Fixture.cursor,
          ledger: 1,
        },
      },
    ]);
  });
});

describe('endpoint shapes: send / action acks (NOT bare Messages)', () => {
  it('sendText parses the Private-API ack { guid, viaPrivateApi } and surfaces the guid', async () => {
    const fx = fixture('sendAck.privateApi.gator.json');
    expect(SendAck.safeParse(fx).success).toBe(true);
    const ack = await sendText(httpReturning(fx), {
      chatGuid: 'c1',
      tempGuid: 't1',
      message: 'hi',
    });
    expect(ack.guid).toBe('p:0/REAL-GUID-1122-3344');
  });

  it('sendText parses the AppleScript ack { viaPrivateApi:false } with NO guid (the old bug: this threw)', async () => {
    const fx = fixture('sendAck.appleScript.gator.json');
    const parsed = SendAck.safeParse(fx);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.guid).toBeUndefined();
    const ack = await sendText(httpReturning(fx), {
      chatGuid: 'c1',
      tempGuid: 't1',
      message: 'hi',
    });
    expect(ack.guid).toBeUndefined();
  });

  it('unsendMessage parses the { unsent: true } status object (not a Message)', async () => {
    const fx = fixture('unsendAck.gator.json');
    expect(UnsendAck.safeParse(fx).success).toBe(true);
    const ack = await unsendMessage(httpReturning(fx), { chatGuid: 'c1', messageGuid: 'm1' });
    expect(ack.unsent).toBe(true);
  });
});

describe('endpoint shapes: single-chat read/create wrapper-or-bare', () => {
  it('getChat accepts a bare chat', async () => {
    const chat = await getChat(httpReturning(fixture('chat.gator.json')), 'g1');
    expect(chat.guid).toBe('iMessage;-;+15551234567');
  });

  it('createChat accepts a { chat } wrapper too', async () => {
    const wrapped = { chat: fixture('chat.gator.json') };
    const chat = await createChat(httpReturning(wrapped), { addresses: ['+1555'], message: 'hi' });
    expect(chat.guid).toBe('iMessage;-;+15551234567');
  });
});

describe('endpoint shapes: facetime status objects', () => {
  it('answerFaceTime reads { answered: true } (NOT a { data: { link } } envelope)', async () => {
    expect(await answerFaceTime(httpReturning({ answered: true }), 'u1')).toBe(true);
  });
  it('leaveFaceTime reads { left: true }', async () => {
    expect(await leaveFaceTime(httpReturning({ left: true }), 'u1')).toBe(true);
  });
  it('createFaceTimeLink reads { link } and tolerates a null link', async () => {
    expect(
      await createFaceTimeLink(httpReturning({ link: 'https://facetime.apple.com/join#x' })),
    ).toBe('https://facetime.apple.com/join#x');
    expect(await createFaceTimeLink(httpReturning({ link: null }))).toBeNull();
  });
});

describe('endpoint shapes: device registration', () => {
  it('registerDevice reads { id } from the /devices op', async () => {
    expect(await registerDevice(httpReturning({ id: 'dev-9' }), 'Phone', 'tok')).toEqual({
      id: 'dev-9',
    });
  });
});
