import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { sendReaction, sendText } from '@core/api/endpoints/messages';
import { Chat, Message, ServerInfo, type ServerInfo as ServerInfoShape } from '@core/models';
import {
  claimFailedOutgoingForRetry,
  OUTGOING_MAX_ATTEMPTS,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { sendIMessageReactionMessage } from '@/services/send/sendReactionService';
import { sendRestoredIMessageReactionMessage } from '@/services/send/sendRestoredReactionService';
import { sendTextMessage } from '@/services/send/sendService';
import { fixedRcsCapabilitySource } from '@/services/send/rcsAttemptCapability';
import { ClientErrorCode } from '@utils';
import { createTestDb } from '../support/testDb';

const GROUP = 'any;+;chat-1234';
const DIRECT = 'iMessage;-;+15550001111';

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

const one = (raw: Database.Database, sql: string) =>
  raw.prepare(sql).get() as Record<string, unknown>;

/** A proven any;+; iMessage group whose target's only remaining part is part 1. */
async function seedGroupTarget(
  db: AppDatabase,
  chatGuid = GROUP,
  secondService = 'iMessage',
): Promise<void> {
  const participants = [
    { address: 'ann@example.com', service: 'iMessage' },
    { address: 'ben@example.com', service: secondService },
  ];
  const handles = await upsertHandles(db, participants);
  const chats = await upsertChats(
    db,
    [Chat.parse({ guid: chatGuid, style: 43, participants })],
    handles,
  );
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: 'group-target',
        text: 'caption',
        dateCreated: 100,
        messagePartTopology: {
          complete: true,
          originalPartIndexes: [0, 1],
          currentParts: [{ index: 1, kind: 'text' }],
          attachmentOwnership: [],
        },
      }),
    ],
    () => chats.get(chatGuid)!,
    handles,
  );
}

const info = (fields: Record<string, unknown>): ServerInfoShape =>
  ServerInfo.parse({ version: '2.0.38', ...fields });

/**
 * Server answers for a restored send. The two "outcome unknown" answers mean the message may already
 * have been sent, so the app must never send it again on its own. `invalid_target` (retryable:
 * false) is a typed refusal for a chat that is not an iMessage group; it must fail, not retry.
 */
const RESTORED_SEND_FAILURES: [string, number, string][] = [
  ['outcome unknown (helper)', 409, 'imessage_restored_send_outcome_unknown'],
  ['outcome unknown (retry ledger)', 500, 'idempotency_outcome_unknown'],
  ['invalid target', 400, 'imessage_restored_send_invalid_target'],
];

const ALL_TAPBACK = {
  supports_imessage_group_reactions: true,
  supports_imessage_emoji_reactions: true,
  supports_imessage_part_reactions: true,
};

describe('FP-006 restored tapbacks', () => {
  it('sends a group emoji tapback on part 1 with the exact server request shape', async () => {
    const { db, raw } = await createTestDb();
    await seedGroupTarget(db);
    const { http, post } = fakeHttp(async () => ({ guid: 'tapback-guid', viaPrivateApi: true }));

    await expect(
      sendRestoredIMessageReactionMessage(
        db,
        http,
        {
          chatGuid: GROUP,
          targetGuid: 'group-target',
          reaction: 'emoji',
          emoji: '👍🏽',
          partIndex: 1,
        },
        () => true,
        undefined,
        () => info(ALL_TAPBACK),
      ),
    ).resolves.toEqual({ guid: 'tapback-guid' });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe('/message/react');
    expect(post.mock.calls[0]?.[2]).toMatchObject({
      json: {
        chatGuid: GROUP,
        messageGuid: 'group-target',
        reactionType: 'emoji',
        reactionEmoji: '👍🏽',
        partIndex: 1,
      },
    });
    // Like the reviewed iMessage tapback: no optimistic row and no retry queue.
    expect(one(raw, 'SELECT COUNT(*) AS count FROM outgoing_queue')).toEqual({ count: 0 });
  });

  it('refuses an any;+; group that is not proven all-iMessage before any request', async () => {
    const { db } = await createTestDb();
    await seedGroupTarget(db, GROUP, 'SMS');
    const { http, post } = fakeHttp(async () => ({ guid: 'must-not-send' }));
    await expect(
      sendRestoredIMessageReactionMessage(
        db,
        http,
        { chatGuid: GROUP, targetGuid: 'group-target', reaction: 'love', partIndex: 1 },
        () => true,
        undefined,
        () => info(ALL_TAPBACK),
      ),
    ).rejects.toThrow('This iMessage reaction is unavailable.');
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses before any request while one needed switch is off', async () => {
    const { db } = await createTestDb();
    await seedGroupTarget(db);
    const { http, post } = fakeHttp(async () => ({ guid: 'must-not-send' }));
    for (const off of Object.keys(ALL_TAPBACK)) {
      await expect(
        sendRestoredIMessageReactionMessage(
          db,
          http,
          {
            chatGuid: GROUP,
            targetGuid: 'group-target',
            reaction: 'emoji',
            emoji: '🎉',
            partIndex: 1,
          },
          () => true,
          undefined,
          () => info({ ...ALL_TAPBACK, [off]: false }),
        ),
      ).rejects.toThrow('unavailable');
    }
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses more than one emoji and a glyph on a classic tapback', async () => {
    const { db } = await createTestDb();
    await seedGroupTarget(db);
    const { http, post } = fakeHttp(async () => ({ guid: 'must-not-send' }));
    for (const args of [
      { reaction: 'emoji', emoji: '👍👍' },
      { reaction: 'love', emoji: '👍' },
      { reaction: 'emoji' },
    ]) {
      await expect(
        sendRestoredIMessageReactionMessage(
          db,
          http,
          { chatGuid: GROUP, targetGuid: 'group-target', partIndex: 1, ...args },
          () => true,
          undefined,
          () => info(ALL_TAPBACK),
        ),
      ).rejects.toThrow('unavailable');
    }
    expect(post).not.toHaveBeenCalled();
  });

  it('keeps the reviewed one-to-one tapback path refusing groups, emoji and part > 0', async () => {
    const { db } = await createTestDb();
    await seedGroupTarget(db);
    const { http, post } = fakeHttp(async () => ({ guid: 'must-not-send' }));
    await expect(
      sendIMessageReactionMessage(
        db,
        http,
        { chatGuid: GROUP, targetGuid: 'group-target', reaction: 'love', partIndex: 1 },
        () => true,
        undefined,
        () => true,
      ),
    ).rejects.toThrow('unavailable');
    expect(post).not.toHaveBeenCalled();
  });

  it.each(RESTORED_SEND_FAILURES)(
    'a tapback answered %s fails once and is never sent again',
    async (_label, status, type) => {
      const { db, raw } = await createTestDb();
      await seedGroupTarget(db);
      const { http, post } = fakeHttp(async () => {
        throw ApiError.fromStatus(status, 'restored send failed', undefined, type);
      });

      await expect(
        sendRestoredIMessageReactionMessage(
          db,
          http,
          { chatGuid: GROUP, targetGuid: 'group-target', reaction: 'love', partIndex: 1 },
          () => true,
          undefined,
          () => info(ALL_TAPBACK),
        ),
      ).rejects.toMatchObject({ status, serverErrorType: type });

      // One POST, with no transport retry policy, and no queue row that could replay it later.
      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0]?.[2]).not.toHaveProperty('retry');
      expect(one(raw, 'SELECT COUNT(*) AS count FROM outgoing_queue')).toEqual({ count: 0 });
    },
  );

  it('the endpoint refuses a group tapback unless the caller proved the restored switches', async () => {
    const { http, post } = fakeHttp(async () => ({ guid: 'g' }));
    const params = { chatGuid: GROUP, selectedMessageGuid: 'm', reaction: 'love', partIndex: 0 };
    await expect(sendReaction(http, params)).rejects.toThrow('supported conversation');
    await expect(
      sendReaction(http, { ...params, chatGuid: 'SMS;+;g' }, { restoredTapback: true }),
    ).rejects.toThrow('supported conversation');
    expect(post).not.toHaveBeenCalled();
    await sendReaction(http, params, { restoredTapback: true });
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('FP-006 restored replies', () => {
  const replyArgs = {
    chatGuid: GROUP,
    text: 'reply text',
    selectedMessageGuid: 'group-target',
    partIndex: 1,
  };

  it('sends a group reply to part 1 with its real part index', async () => {
    const { db } = await createTestDb();
    await seedGroupTarget(db);
    const { http, post } = fakeHttp(async () => ({ guid: 'reply-guid', viaPrivateApi: true }));

    await sendTextMessage(
      db,
      http,
      replyArgs,
      1_000,
      undefined,
      undefined,
      undefined,
      fixedRcsCapabilitySource(
        info({ supports_imessage_group_replies: true, supports_imessage_part_replies: true }),
      ),
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe('/message/text');
    expect((post.mock.calls[0]?.[2] as { json: Record<string, unknown> }).json).toEqual({
      chatGuid: GROUP,
      tempGuid: expect.stringMatching(/^temp-/),
      text: 'reply text',
      selectedMessageGuid: 'group-target',
      partIndex: 1,
    });
  });

  it.each([
    ['no restored switch', { supports_imessage_replies: true }],
    ['the group switch only', { supports_imessage_group_replies: true }],
    ['the part switch only', { supports_imessage_part_replies: true }],
  ])('refuses a group part-1 reply with %s, before DB or HTTP', async (_label, fields) => {
    const { db, raw } = await createTestDb();
    await seedGroupTarget(db);
    const { http, post } = fakeHttp(async () => ({ guid: 'must-not-send', viaPrivateApi: true }));

    await expect(
      sendTextMessage(
        db,
        http,
        replyArgs,
        1_000,
        undefined,
        undefined,
        undefined,
        fixedRcsCapabilitySource(info(fields)),
      ),
    ).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
    expect(one(raw, 'SELECT COUNT(*) AS count FROM outgoing_queue')).toEqual({ count: 0 });
  });

  it('refuses a group reply when the participants are not proven iMessage', async () => {
    const { db } = await createTestDb();
    const participants = [
      { address: '+15550001111', service: 'SMS' },
      { address: '+15550002222', service: 'SMS' },
    ];
    const handles = await upsertHandles(db, participants);
    const chats = await upsertChats(
      db,
      [Chat.parse({ guid: GROUP, style: 43, participants })],
      handles,
    );
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'group-target',
          text: 'x',
          dateCreated: 100,
          messagePartTopology: {
            complete: true,
            originalPartIndexes: [0],
            currentParts: [{ index: 0, kind: 'text' }],
            attachmentOwnership: [],
          },
        }),
      ],
      () => chats.get(GROUP)!,
      handles,
    );
    const { http, post } = fakeHttp(async () => ({ guid: 'must-not-send', viaPrivateApi: true }));
    await expect(
      sendTextMessage(
        db,
        http,
        { ...replyArgs, partIndex: 0 },
        1_000,
        undefined,
        undefined,
        undefined,
        fixedRcsCapabilitySource(info({ supports_imessage_group_replies: true })),
      ),
    ).rejects.toThrow('proven existing iMessage group');
    expect(post).not.toHaveBeenCalled();
  });

  it.each(RESTORED_SEND_FAILURES.filter(([, status]) => status !== 400))(
    'a group part-1 reply answered %s is recorded as failed and never retried',
    async (_label, status, type) => {
      const { db, raw } = await createTestDb();
      await seedGroupTarget(db);
      const { http, post } = fakeHttp(async () => {
        throw ApiError.fromStatus(status, 'restored send failed', undefined, type);
      });

      const result = await sendTextMessage(
        db,
        http,
        replyArgs,
        1_000,
        undefined,
        undefined,
        undefined,
        fixedRcsCapabilitySource(
          info({ supports_imessage_group_replies: true, supports_imessage_part_replies: true }),
        ),
      );

      // Shown as a failed reply that may have been delivered; the queue never replays it and a
      // manual Try Again is refused, so the server's "may have been sent" can't become a duplicate.
      expect(
        one(
          raw,
          'SELECT error AS code, attempts FROM messages JOIN outgoing_queue ON temp_guid=guid',
        ),
      ).toEqual({
        code: ClientErrorCode.replyDeliveryUnconfirmed,
        attempts: OUTGOING_MAX_ATTEMPTS,
      });
      await expect(claimFailedOutgoingForRetry(db, result.tempGuid)).resolves.toMatchObject({
        claim: 'unsendable',
      });
      expect(post).toHaveBeenCalledTimes(1);
    },
  );

  it('a group part-1 reply refused as an invalid target says it was not sent, and is never retried', async () => {
    const { db, raw } = await createTestDb();
    await seedGroupTarget(db);
    const { http, post } = fakeHttp(async () => {
      throw ApiError.fromStatus(
        400,
        'restored send refused',
        undefined,
        'imessage_restored_send_invalid_target',
      );
    });

    const result = await sendTextMessage(
      db,
      http,
      replyArgs,
      1_000,
      undefined,
      undefined,
      undefined,
      fixedRcsCapabilitySource(
        info({ supports_imessage_group_replies: true, supports_imessage_part_replies: true }),
      ),
    );

    // The server proved nothing was sent, so the row says "rejected", not "may have been delivered".
    expect(
      one(
        raw,
        'SELECT error AS code, error_message AS detail, attempts FROM messages JOIN outgoing_queue ON temp_guid=guid',
      ),
    ).toEqual({
      code: 400,
      detail: 'The server rejected this reply before dispatch. This attempt was not sent.',
      attempts: OUTGOING_MAX_ATTEMPTS,
    });
    await expect(claimFailedOutgoingForRetry(db, result.tempGuid)).resolves.toMatchObject({
      claim: 'unsendable',
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('the endpoint keeps the reviewed one-to-one part-zero reply unless restored', () => {
    const { http, post } = fakeHttp(async () => ({ guid: 'g' }));
    const base = {
      chatGuid: DIRECT,
      tempGuid: 'temp-1',
      message: 'hi',
      selectedMessageGuid: 'm',
      partIndex: 2,
    };
    expect(() => sendText(http, base)).toThrow('part zero');
    expect(() => sendText(http, { ...base, chatGuid: GROUP, partIndex: 0 })).toThrow(
      'existing iMessage conversation',
    );
    expect(() => sendText(http, { ...base, partIndex: 64 }, { restoredReply: true })).toThrow(
      'part zero',
    );
    expect(() =>
      sendText(http, { ...base, message: 'carriage\rreturn' }, { restoredReply: true }),
    ).toThrow('control');
    expect(post).not.toHaveBeenCalled();
    void sendText(http, { ...base, chatGuid: GROUP }, { restoredReply: true });
    expect((post.mock.calls[0]?.[2] as { json: { partIndex: number } }).json.partIndex).toBe(2);
  });
});
