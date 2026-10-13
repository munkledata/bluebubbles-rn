import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { SendAck } from '@core/api/endpoints/messages';
import type { HttpClient } from '@core/api/http';
import { Chat, Message } from '@core/models';
import { logger } from '@core/secure';
import { ClientErrorCode } from '@utils';
import {
  applyServerSendError,
  claimFailedOutgoingForRetry,
  getChatIdByGuid,
  imessagePlainTextQueueState,
  insertOutgoingAttachment,
  insertOutgoingReaction,
  insertOutgoingText,
  listRetryableOutgoing,
  outgoingBackoffMs,
  OUTGOING_MAX_ATTEMPTS,
  type RetryableOutgoing,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { notifyFailedSend } from '@/services/send/sendFailureNotice';
import {
  resendOutgoingRow,
  runOutgoingQueue,
  type OutgoingQueueIO,
} from '@/services/send/outgoingQueueService';
import { uploadRegistry } from '@/services/send/uploadControl';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { createTestDb } from '../support/testDb';
import { insertOutgoingContact } from '../support/repositoryWrappers';

jest.mock('@/services/send/sendFailureNotice', () => ({
  clearFailedSendNotice: jest.fn(async () => undefined),
  notifyFailedSend: jest.fn(async () => undefined),
}));

const mockNotifyFailedSend = notifyFailedSend as jest.Mock;

const RCS_PROVIDER_EPOCH = `gpe1_${'A'.repeat(43)}`;
const rcsChatGuid = (sourceId: string): string =>
  `RCS;-;g1.${RCS_PROVIDER_EPOCH}.${Buffer.from(sourceId).toString('base64url')}`;
const rcsMessageGuid = (sourceId: string): string =>
  `rcs-g1.${RCS_PROVIDER_EPOCH}.${Buffer.from(sourceId).toString('base64url')}`;
const RCS_CHAT_GUID = rcsChatGuid('thread-1');
const rcsAvailable = (chatGuid?: string): boolean =>
  chatGuid === undefined || chatGuid.startsWith(`RCS;-;g1.${RCS_PROVIDER_EPOCH}.`);

beforeEach(() => {
  mockNotifyFailedSend.mockClear();
});

function fakeHttp(impl: (json: unknown) => Promise<unknown>): HttpClient {
  let client!: HttpClient;
  client = {
    post: (_path: string, _schema: unknown, opts: { json?: unknown }) => impl(opts?.json),
    pinTransport: () => client,
    assertTransportCurrent: () => undefined,
    isTransportCurrent: () => true,
  } as unknown as HttpClient;
  return client;
}
const noRequestHttp = fakeHttp(async () => {
  throw new Error('unexpected HTTP request');
});
const okHttp = (now: number): HttpClient =>
  fakeHttp(async () => ({ guid: 'real-1', dateCreated: now, dateDelivered: null }));
const failHttp = (): HttpClient =>
  fakeHttp(async () => {
    throw new ApiError('unauthorized', 'boom', 500);
  });
/** RCS-shaped ack: the bridge echoes back the client's OWN tempGuid as its correlation token. */
const rcsEchoHttp = (): HttpClient =>
  fakeHttp(async (json) => ({
    guid: (json as { tempGuid: string }).tempGuid,
    dateCreated: null,
    dateDelivered: null,
  }));

/** IO stub for text/reaction-only tests: any attachment upload is a test failure. */
const noAttachmentIo: OutgoingQueueIO = {
  upload: async () => {
    throw new Error('unexpected attachment upload');
  },
  fileExists: async () => true,
};

type UploadArgs = Parameters<OutgoingQueueIO['upload']>[0];
/** Attachment IO fake that captures the args the queue passed to the uploader. */
function fakeIo(impl: {
  upload?: (args: UploadArgs) => Promise<SendAck>;
  fileExists?: (uri: string) => Promise<boolean>;
}): { io: OutgoingQueueIO; captured?: UploadArgs } {
  const holder: { io: OutgoingQueueIO; captured?: UploadArgs } = {
    io: {
      upload: async (args) => {
        holder.captured = args;
        if (!impl.upload) throw new Error('unexpected attachment upload');
        return impl.upload(args);
      },
      fileExists: impl.fileExists ?? (async () => true),
    },
  };
  return holder;
}

async function seedChat(db: AppDatabase, guid: string): Promise<void> {
  const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
  await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@b.com' }] })], handles);
}

async function seedExactTextTarget(
  db: AppDatabase,
  guid: string,
  partIndex: number,
): Promise<void> {
  const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
  const chats = await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: [{ address: 'a@b.com' }] })],
    handles,
  );
  await upsertMessages(
    db,
    [
      Message.parse({
        guid,
        text: 'target',
        dateCreated: 500,
        messagePartTopology: {
          complete: true,
          originalPartIndexes: [partIndex, partIndex + 1],
          currentParts: [
            { index: partIndex, kind: 'text' },
            { index: partIndex + 1, kind: 'text' },
          ],
          attachmentOwnership: [],
        },
      }),
    ],
    () => chats.get('c1')!,
    handles,
  );
}

async function seedLegacyTextTarget(db: AppDatabase, guid: string): Promise<void> {
  const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
  const chats = await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: [{ address: 'a@b.com' }] })],
    handles,
  );
  await upsertMessages(
    db,
    [Message.parse({ guid, text: 'legacy target', dateCreated: 500 })],
    () => chats.get('c1')!,
    handles,
  );
}

async function seedWholeMessageRcsTarget(db: AppDatabase, guid: string): Promise<void> {
  const handles = await upsertHandles(db, [{ address: '+15550001111' }]);
  const chats = await upsertChats(
    db,
    [Chat.parse({ guid: RCS_CHAT_GUID, participants: [{ address: '+15550001111' }] })],
    handles,
  );
  await upsertMessages(
    db,
    [Message.parse({ guid, text: 'RCS target', dateCreated: 500 })],
    () => chats.get(RCS_CHAT_GUID)!,
    handles,
  );
}

async function seedExactRcsTextTarget(
  db: AppDatabase,
  guid: string,
  partIndex: number,
): Promise<void> {
  const handles = await upsertHandles(db, [{ address: '+15550001111' }]);
  const chats = await upsertChats(
    db,
    [Chat.parse({ guid: RCS_CHAT_GUID, participants: [{ address: '+15550001111' }] })],
    handles,
  );
  await upsertMessages(
    db,
    [
      Message.parse({
        guid,
        text: 'RCS target',
        dateCreated: 500,
        messagePartTopology: {
          complete: true,
          originalPartIndexes: [partIndex],
          currentParts: [{ index: partIndex, kind: 'text' }],
          attachmentOwnership: [],
        },
      }),
    ],
    () => chats.get(RCS_CHAT_GUID)!,
    handles,
  );
}
const queueCount = (raw: Database.Database): number =>
  (raw.prepare('SELECT COUNT(*) c FROM outgoing_queue').get() as { c: number }).c;
const stateOf = (raw: Database.Database, guid: string): string | undefined =>
  (raw.prepare('SELECT send_state s FROM messages WHERE guid = ?').get(guid) as { s: string })?.s;
const errorOf = (raw: Database.Database, guid: string): number | undefined =>
  (raw.prepare('SELECT error e FROM messages WHERE guid = ?').get(guid) as { e: number })?.e;
const attemptsOf = (raw: Database.Database, tempGuid: string): number | undefined =>
  (
    raw.prepare('SELECT attempts a FROM outgoing_queue WHERE temp_guid = ?').get(tempGuid) as {
      a: number;
    }
  )?.a;

interface RevocableLeaseHarness {
  lease: RealtimeDeliveryLease;
  revoke(): void;
  waitForChecks(count: number): Promise<void>;
}

/** Observe the exact point where runTrackedRealtimeWork admitted a commit before revoking it. */
function revocableLease(): RevocableLeaseHarness {
  let current = true;
  let checks = 0;
  const waiters: { count: number; resolve: () => void }[] = [];
  const resolveSatisfiedWaiters = (): void => {
    for (const waiter of [...waiters]) {
      if (checks < waiter.count) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  return {
    lease: {
      generation: 7,
      isCurrent: () => {
        checks += 1;
        resolveSatisfiedWaiters();
        return current;
      },
    },
    revoke: () => {
      current = false;
    },
    waitForChecks: async (count) => {
      if (checks >= count) return;
      await new Promise<void>((resolve) => waiters.push({ count, resolve }));
    },
  };
}

/** Hold the real process-wide mutex so an account-scoped commit is forced to wait behind it. */
async function holdDbTransaction(db: AppDatabase): Promise<{
  release(): void;
  finished: Promise<void>;
}> {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finished = withDbTransaction(db, async () => {
    entered();
    await blocked;
  });
  await started;
  return { release, finished };
}

async function retryableRow(db: AppDatabase, now: number): Promise<RetryableOutgoing> {
  const rows = await listRetryableOutgoing(db, now);
  const row = rows[0];
  if (!row) throw new Error('expected a retryable outgoing row');
  return row;
}

const RCS_ATTACHMENT_CHAT_GUID = rcsChatGuid('queue-attachment-thread');

/** Insert an outgoing text whose created_at is forced old, so it's a stranded (eligible) row. */
async function strandedText(
  db: AppDatabase,
  raw: Database.Database,
  chatGuid: string,
  tempGuid: string,
  createdAt: number,
): Promise<void> {
  const chatId = await getChatIdByGuid(db, chatGuid);
  await insertOutgoingText(db, { tempGuid, chatId: chatId!, chatGuid, text: 'hi', now: createdAt });
  raw
    .prepare('UPDATE outgoing_queue SET created_at = ? WHERE temp_guid = ?')
    .run(createdAt, tempGuid);
}

/** Seed a FAILED optimistic picture: attachment rows + queue row forced already-failed/eligible. */
async function seedFailedAttachment(
  db: AppDatabase,
  raw: Database.Database,
  tempGuid: string,
  combined?: { text: string; selectedMessageGuid?: string; partIndex?: number },
): Promise<void> {
  await seedChat(db, RCS_ATTACHMENT_CHAT_GUID);
  const chatId = await getChatIdByGuid(db, RCS_ATTACHMENT_CHAT_GUID);
  await insertOutgoingAttachment(db, {
    tempGuid,
    attachmentGuid: `${tempGuid}-att`,
    chatId: chatId!,
    chatGuid: RCS_ATTACHMENT_CHAT_GUID,
    localPath: 'file:///pic.jpg',
    mimeType: 'image/jpeg',
    transferName: 'pic.jpg',
    totalBytes: 1234,
    now: 1000,
    text: combined?.text,
    selectedMessageGuid: combined?.selectedMessageGuid,
    partIndex: combined?.partIndex,
  });
  raw.prepare("UPDATE messages SET send_state='error', error=502 WHERE guid=?").run(tempGuid);
  raw
    .prepare('UPDATE outgoing_queue SET attempts=1, next_retry_at=0 WHERE temp_guid=?')
    .run(tempGuid);
}

describe('outgoingBackoffMs', () => {
  it('doubles per attempt and caps at 1h', () => {
    expect(outgoingBackoffMs(1)).toBe(30_000);
    expect(outgoingBackoffMs(2)).toBe(60_000);
    expect(outgoingBackoffMs(3)).toBe(120_000);
    expect(outgoingBackoffMs(99)).toBe(3_600_000);
  });
});

describe('runOutgoingQueue', () => {
  it('consumes the narrow retry proof before POST, restores it for pre-dispatch failures, and retires server-reported uncertainty', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = 'any;-;+15551234567';
    const tempGuid = 'temp-plain-retry';
    await seedChat(db, chatGuid);
    await insertOutgoingText(db, {
      tempGuid,
      chatGuid,
      text: 'one certified retry',
      now: 1_000,
      imessagePlainTextV1: true,
    });
    const queued = raw
      .prepare('SELECT payload FROM outgoing_queue WHERE temp_guid = ?')
      .get(tempGuid) as { payload: string };
    raw
      .prepare(
        `UPDATE outgoing_queue
            SET payload = ?, attempts = 1, next_retry_at = 0
          WHERE temp_guid = ?`,
      )
      .run(
        JSON.stringify({
          ...(JSON.parse(queued.payload) as Record<string, unknown>),
          imessagePlainTextRetrySafeV1: true,
        }),
        tempGuid,
      );
    raw
      .prepare("UPDATE messages SET send_state = 'error', error = 503 WHERE guid = ?")
      .run(tempGuid);

    let calls = 0;
    const http = fakeHttp(async () => {
      calls += 1;
      const inFlight = raw
        .prepare('SELECT payload FROM outgoing_queue WHERE temp_guid = ?')
        .get(tempGuid) as { payload: string };
      expect(JSON.parse(inFlight.payload)).toMatchObject({ imessagePlainTextV1: true });
      expect(JSON.parse(inFlight.payload)).not.toHaveProperty('imessagePlainTextRetrySafeV1');
      if (calls === 1) {
        throw ApiError.fromStatus(
          503,
          'helper unavailable',
          undefined,
          'imessage_plain_text_unavailable',
        );
      }
      // The server itself says this attempt may have been sent: never replay it.
      throw ApiError.fromStatus(500, 'outcome unknown', undefined, 'idempotency_outcome_unknown');
    });
    const run = (now: number, available = true) =>
      runOutgoingQueue(
        db,
        http,
        noAttachmentIo,
        now,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => available,
      );

    await expect(run(1_500_000, false)).resolves.toEqual({ eligible: 0, sent: 0 });
    expect(calls).toBe(0);
    expect(
      JSON.parse(
        (raw.prepare('SELECT payload FROM outgoing_queue').get() as { payload: string }).payload,
      ),
    ).toMatchObject({
      imessagePlainTextRetrySafeV1: true,
    });
    await expect(run(2_000_000)).resolves.toEqual({ eligible: 1, sent: 0 });
    const retryable = raw.prepare('SELECT attempts, payload FROM outgoing_queue').get() as {
      attempts: number;
      payload: string;
    };
    expect(retryable.attempts).toBe(2);
    expect(JSON.parse(retryable.payload)).toMatchObject({
      imessagePlainTextV1: true,
      imessagePlainTextRetrySafeV1: true,
    });

    await expect(run(3_000_000)).resolves.toEqual({ eligible: 1, sent: 0 });
    const retired = raw.prepare('SELECT attempts, payload FROM outgoing_queue').get() as {
      attempts: number;
      payload: string;
    };
    expect(retired.attempts).toBe(OUTGOING_MAX_ATTEMPTS);
    expect(JSON.parse(retired.payload)).toMatchObject({ imessagePlainTextV1: true });
    expect(JSON.parse(retired.payload)).not.toHaveProperty('imessagePlainTextRetrySafeV1');
    await expect(run(4_000_000)).resolves.toEqual({ eligible: 0, sent: 0 });
    expect(calls).toBe(2);
  });

  it('keeps an offline retry on the ladder and sends it with the same tempGuid when the network returns', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = 'any;-;+15551234567';
    const tempGuid = 'temp-plain-offline';
    await seedChat(db, chatGuid);
    await insertOutgoingText(db, {
      tempGuid,
      chatGuid,
      text: 'On my way',
      now: 1_000,
      imessagePlainTextV1: true,
    });
    const queued = raw
      .prepare('SELECT payload FROM outgoing_queue WHERE temp_guid = ?')
      .get(tempGuid) as { payload: string };
    raw
      .prepare(
        `UPDATE outgoing_queue
            SET payload = ?, attempts = 1, next_retry_at = 0
          WHERE temp_guid = ?`,
      )
      .run(
        JSON.stringify({
          ...(JSON.parse(queued.payload) as Record<string, unknown>),
          imessagePlainTextRetrySafeV1: true,
        }),
        tempGuid,
      );
    raw
      .prepare("UPDATE messages SET send_state = 'error', error = 503 WHERE guid = ?")
      .run(tempGuid);

    let online = false;
    const posted: string[] = [];
    const http = fakeHttp(async (json) => {
      posted.push((json as { tempGuid: string }).tempGuid);
      if (!online) throw new ApiError('no_connection', 'Network request failed');
      return { guid: '11111111-2222-4333-8444-666666666666', tempGuid, viaPrivateApi: true };
    });
    const run = (now: number) =>
      runOutgoingQueue(
        db,
        http,
        noAttachmentIo,
        now,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => true,
      );

    await expect(run(2_000_000)).resolves.toEqual({ eligible: 1, sent: 0 });
    const offline = raw.prepare('SELECT attempts, payload FROM outgoing_queue').get() as {
      attempts: number;
      payload: string;
    };
    expect(offline.attempts).toBe(2);
    expect(JSON.parse(offline.payload)).toMatchObject({ imessagePlainTextRetrySafeV1: true });

    online = true;
    await expect(run(3_000_000)).resolves.toEqual({ eligible: 1, sent: 1 });
    // Same tempGuid both times, so bbd's idempotency cache absorbs any ack-lost duplicate.
    expect(posted).toEqual([tempGuid, tempGuid]);
    expect(raw.prepare('SELECT send_state AS sendState FROM messages').get()).toEqual({
      sendState: 'sent',
    });
  });

  it('retires interrupted or corrupt narrow markers without downgrading to AppleScript', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = 'iMessage;-;+15551234567';
    await seedChat(db, chatGuid);
    const corruptions: Array<[string, Record<string, unknown>]> = [
      ['temp-plain-interrupted', { imessagePlainTextV1: true }],
      ['temp-plain-false', { imessagePlainTextV1: false }],
      ['temp-plain-string', { imessagePlainTextV1: 'true' }],
      ['temp-plain-stray-proof', { imessagePlainTextRetrySafeV1: true }],
      ['temp-plain-numeric', { imessagePlainTextV1: 1, imessagePlainTextRetrySafeV1: 1 }],
      ['temp-plain-proof-numeric', { imessagePlainTextV1: true, imessagePlainTextRetrySafeV1: 1 }],
      ...Object.entries({
        subject: 'must retain subject',
        effectId: 'com.apple.messages.effect.CKConfettiEffect',
        mentions: [],
        textFormatting: [],
        imessageEffectV1: true,
        imessageMentionV1: true,
        imessageFormattedV1: true,
        unexpected: true,
      }).map(([key, value]): [string, Record<string, unknown>] => [
        `temp-plain-conflict-${key}`,
        {
          imessagePlainTextV1: true,
          imessagePlainTextRetrySafeV1: true,
          [key]: value,
        },
      ]),
    ];
    expect(
      imessagePlainTextQueueState(
        'contact',
        JSON.stringify({
          message: 'wrong kind',
          imessagePlainTextV1: true,
          imessagePlainTextRetrySafeV1: true,
        }),
      ),
    ).toBe('unsafe');
    for (const [tempGuid, marker] of corruptions) {
      await insertOutgoingText(db, { tempGuid, chatGuid, text: 'must not replay', now: 1_000 });
      const queued = raw
        .prepare('SELECT payload FROM outgoing_queue WHERE temp_guid = ?')
        .get(tempGuid) as { payload: string };
      raw
        .prepare(
          `UPDATE outgoing_queue
              SET payload = ?, attempts = 1, next_retry_at = 0
            WHERE temp_guid = ?`,
        )
        .run(JSON.stringify({ ...(JSON.parse(queued.payload) as object), ...marker }), tempGuid);
      raw
        .prepare("UPDATE messages SET send_state = 'error', error = 500 WHERE guid = ?")
        .run(tempGuid);
    }

    const request = jest.fn(async () => {
      throw new Error('unexpected HTTP request');
    });
    await expect(
      runOutgoingQueue(
        db,
        fakeHttp(request),
        noAttachmentIo,
        2_000_000,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => false,
      ),
    ).resolves.toEqual({ eligible: corruptions.length, sent: 0 });
    expect(request).not.toHaveBeenCalled();
    for (const [tempGuid] of corruptions) {
      expect(attemptsOf(raw, tempGuid)).toBe(OUTGOING_MAX_ATTEMPTS);
      expect(errorOf(raw, tempGuid)).toBe(ClientErrorCode.messageDeliveryUnconfirmed);
    }
  });

  it('does not reuse a listed retry proof after another drain consumed and retired it', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = 'any;-;+15551234567';
    await seedChat(db, chatGuid);
    await insertOutgoingText(db, {
      tempGuid: 'temp-blocking-first',
      chatGuid,
      text: 'first',
      now: 1_000,
    });
    await insertOutgoingText(db, {
      tempGuid: 'temp-plain-stale-proof',
      chatGuid,
      text: 'one certified attempt',
      now: 2_000,
      imessagePlainTextV1: true,
    });
    const queued = raw
      .prepare('SELECT payload FROM outgoing_queue WHERE temp_guid = ?')
      .get('temp-plain-stale-proof') as { payload: string };
    raw.prepare('UPDATE outgoing_queue SET payload = ? WHERE temp_guid = ?').run(
      JSON.stringify({
        ...(JSON.parse(queued.payload) as object),
        imessagePlainTextRetrySafeV1: true,
      }),
      'temp-plain-stale-proof',
    );
    raw.prepare('UPDATE outgoing_queue SET attempts = 1, next_retry_at = 0').run();
    raw.prepare("UPDATE messages SET send_state = 'error', error = 500").run();

    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = jest.fn(async (json: unknown) => {
      const payload = json as { tempGuid: string };
      if (payload.tempGuid === 'temp-blocking-first') {
        entered();
        await blocked;
        return { guid: 'real-blocking-first' };
      }
      throw ApiError.fromStatus(
        409,
        'unknown delivery outcome',
        undefined,
        'imessage_plain_text_outcome_unknown',
      );
    });
    let now = 2_000_000;
    const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const run = () =>
      runOutgoingQueue(
        db,
        fakeHttp(request),
        noAttachmentIo,
        now,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => true,
      );
    const first = run();
    try {
      await started;
      await expect(run()).resolves.toEqual({ eligible: 1, sent: 0 });
      expect(attemptsOf(raw, 'temp-plain-stale-proof')).toBe(OUTGOING_MAX_ATTEMPTS);
      now += 120_001;
      release();
      await expect(first).resolves.toEqual({ eligible: 2, sent: 1 });
      expect(request).toHaveBeenCalledTimes(2);
      expect(attemptsOf(raw, 'temp-plain-stale-proof')).toBe(OUTGOING_MAX_ATTEMPTS);
      expect(
        JSON.parse(
          (raw.prepare('SELECT payload FROM outgoing_queue').get() as { payload: string }).payload,
        ),
      ).not.toHaveProperty('imessagePlainTextRetrySafeV1');
    } finally {
      release();
      await first;
      dateNow.mockRestore();
    }
  });

  it('skips disabled RCS work before claim and still sends a later AppleScript row', async () => {
    const { db, raw } = await createTestDb();
    const rcsGuid = 'RCS;-;disabled-recovery-thread';
    await seedChat(db, rcsGuid);
    await seedChat(db, 'c1');
    await strandedText(db, raw, rcsGuid, 'temp-disabled-rcs', 100);
    await strandedText(db, raw, 'c1', 'temp-later-apple', 200);
    raw
      .prepare(
        `UPDATE messages
            SET send_state = 'error', error = 502
          WHERE guid IN ('temp-disabled-rcs', 'temp-later-apple')`,
      )
      .run();
    raw
      .prepare(
        `UPDATE outgoing_queue
            SET attempts = 1, next_retry_at = 0
          WHERE temp_guid IN ('temp-disabled-rcs', 'temp-later-apple')`,
      )
      .run();

    const posts: Record<string, unknown>[] = [];
    await expect(
      runOutgoingQueue(
        db,
        fakeHttp(async (body) => {
          posts.push(body as Record<string, unknown>);
          return { guid: 'real-later-apple', dateCreated: 2_000, dateDelivered: null };
        }),
        noAttachmentIo,
        2_000_000,
        undefined,
        1,
        undefined,
        undefined,
        () => false,
      ),
    ).resolves.toEqual({ eligible: 1, sent: 1 });

    expect(posts).toEqual([
      expect.objectContaining({
        chatGuid: 'c1',
        tempGuid: 'temp-later-apple',
        method: 'apple-script',
      }),
    ]);
    expect(
      raw
        .prepare(
          `SELECT attempts, next_retry_at AS nextRetryAt
             FROM outgoing_queue
            WHERE temp_guid = 'temp-disabled-rcs'`,
        )
        .get(),
    ).toEqual({ attempts: 1, nextRetryAt: 0 });
    expect(stateOf(raw, 'temp-disabled-rcs')).toBe('error');
  });

  it('does not let an old-provider RCS row consume the bounded candidate cap', async () => {
    const { db, raw } = await createTestDb();
    const staleEpoch = `gpe1_${'B'.repeat(43)}`;
    const staleRcsGuid = `RCS;-;g1.${staleEpoch}.${Buffer.from('old-thread').toString('base64url')}`;
    const currentRcsGuid = rcsChatGuid('current-thread');
    await seedChat(db, staleRcsGuid);
    await seedChat(db, currentRcsGuid);
    await strandedText(db, raw, staleRcsGuid, 'temp-stale-provider-rcs', 100);
    await strandedText(db, raw, currentRcsGuid, 'temp-current-provider-rcs', 200);
    raw
      .prepare(
        `UPDATE messages
            SET send_state = 'error', error = 502
          WHERE guid IN ('temp-stale-provider-rcs', 'temp-current-provider-rcs')`,
      )
      .run();
    raw
      .prepare(
        `UPDATE outgoing_queue
            SET attempts = 1, next_retry_at = 0
          WHERE temp_guid IN ('temp-stale-provider-rcs', 'temp-current-provider-rcs')`,
      )
      .run();

    const posts: Record<string, unknown>[] = [];
    await expect(
      runOutgoingQueue(
        db,
        fakeHttp(async (body) => {
          posts.push(body as Record<string, unknown>);
          return { guid: 'temp-current-provider-rcs', dateCreated: 2_000, dateDelivered: null };
        }),
        noAttachmentIo,
        2_000_000,
        undefined,
        1,
        undefined,
        undefined,
        (chatGuid?: string) =>
          chatGuid === undefined || chatGuid.startsWith(`RCS;-;g1.${RCS_PROVIDER_EPOCH}.`),
        undefined,
        undefined,
        RCS_PROVIDER_EPOCH,
      ),
    ).resolves.toEqual({ eligible: 1, sent: 1 });

    expect(posts).toEqual([
      expect.objectContaining({
        chatGuid: currentRcsGuid,
        tempGuid: 'temp-current-provider-rcs',
      }),
    ]);
    expect(attemptsOf(raw, 'temp-stale-provider-rcs')).toBe(1);
    expect(stateOf(raw, 'temp-stale-provider-rcs')).toBe('error');
  });

  it('immediately defers an RCS claim when capability disappears before network start', async () => {
    const { db, raw } = await createTestDb();
    const rcsGuid = 'RCS;-;mid-claim-capability-thread';
    await seedChat(db, rcsGuid);
    await seedChat(db, 'c1');
    await strandedText(db, raw, rcsGuid, 'temp-mid-claim-rcs', 100);
    await strandedText(db, raw, 'c1', 'temp-after-defer-apple', 200);
    raw
      .prepare(
        `UPDATE messages
            SET send_state = 'error', error = 502, error_message = 'prior failure'
          WHERE guid = 'temp-mid-claim-rcs'`,
      )
      .run();
    raw
      .prepare(
        `UPDATE messages
            SET send_state = 'error', error = 503
          WHERE guid = 'temp-after-defer-apple'`,
      )
      .run();
    raw
      .prepare(
        `UPDATE outgoing_queue
            SET attempts = CASE temp_guid WHEN 'temp-mid-claim-rcs' THEN 2 ELSE 1 END,
                next_retry_at = 0
          WHERE temp_guid IN ('temp-mid-claim-rcs', 'temp-after-defer-apple')`,
      )
      .run();

    let rcsAvailable = true;
    let flipCapability = true;
    const posts: Record<string, unknown>[] = [];
    let http!: HttpClient;
    http = {
      post: async (_path: string, _schema: unknown, opts: { json?: unknown }) => {
        posts.push(opts.json as Record<string, unknown>);
        return { guid: 'real-after-defer-apple', dateCreated: 2_000, dateDelivered: null };
      },
      pinTransport: () => http,
      assertTransportCurrent: () => {
        if (!flipCapability) return;
        flipCapability = false;
        rcsAvailable = false;
      },
      isTransportCurrent: () => true,
    } as unknown as HttpClient;

    await expect(
      runOutgoingQueue(
        db,
        http,
        noAttachmentIo,
        2_000_000,
        undefined,
        undefined,
        undefined,
        undefined,
        () => rcsAvailable,
      ),
    ).resolves.toEqual({ eligible: 2, sent: 1 });

    expect(posts).toEqual([
      expect.objectContaining({
        chatGuid: 'c1',
        tempGuid: 'temp-after-defer-apple',
        method: 'apple-script',
      }),
    ]);
    expect(
      raw
        .prepare(
          `SELECT attempts, next_retry_at AS nextRetryAt
             FROM outgoing_queue
            WHERE temp_guid = 'temp-mid-claim-rcs'`,
        )
        .get(),
    ).toEqual({ attempts: 2, nextRetryAt: 0 });
    expect(
      raw
        .prepare(
          `SELECT send_state AS sendState, error, error_message AS errorMessage
             FROM messages
            WHERE guid = 'temp-mid-claim-rcs'`,
        )
        .get(),
    ).toEqual({ sendState: 'error', error: 502, errorMessage: 'prior failure' });
  });

  it('uses AppleScript only for plain recovered iMessage text and retires helper-only rows', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await seedExactTextTarget(db, 'reply-target', 2);
    const chatId = (await getChatIdByGuid(db, 'c1'))!;

    await insertOutgoingText(db, {
      tempGuid: 'temp-plain',
      chatGuid: 'c1',
      text: 'plain text survives',
      now: 1_000,
    });
    await insertOutgoingText(db, {
      tempGuid: 'temp-rich',
      chatGuid: 'c1',
      text: 'must not send',
      selectedMessageGuid: 'reply-target',
      partIndex: 2,
      effectId: 'com.apple.MobileSMS.expressivesend.impact',
      subject: 'retired subject',
      mentions: [{ start: 0, length: 4, address: 'a@b.com' }],
      now: 1_000,
    });
    await insertOutgoingReaction(db, {
      tempGuid: 'temp-retired-reaction',
      chatId,
      chatGuid: 'c1',
      targetGuid: 'reply-target',
      reaction: 'love',
      partIndex: 2,
      now: 1_000,
    });
    await insertOutgoingContact(db, {
      tempGuid: 'temp-retired-contact',
      chatGuid: 'c1',
      text: 'Ada Lovelace',
      contact: { firstName: 'Ada', lastName: 'Lovelace' },
      now: 1_000,
    });
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-retired-attachment',
      attachmentGuid: 'temp-retired-attachment-att',
      chatGuid: 'c1',
      localPath: 'file:///must-not-open.jpg',
      mimeType: 'image/jpeg',
      transferName: 'must-not-open.jpg',
      totalBytes: 10,
      now: 1_000,
    });
    const retired = [
      'temp-rich',
      'temp-retired-reaction',
      'temp-retired-contact',
      'temp-retired-attachment',
    ];
    raw
      .prepare(
        `UPDATE messages SET send_state = 'error', error = 500
          WHERE guid IN (${retired.map(() => '?').join(', ')})`,
      )
      .run(...retired);
    raw.prepare('UPDATE outgoing_queue SET created_at = 0, next_retry_at = 0').run();

    const posts: Record<string, unknown>[] = [];
    let fileChecks = 0;
    let uploads = 0;
    await expect(
      runOutgoingQueue(
        db,
        fakeHttp(async (body) => {
          posts.push(body as Record<string, unknown>);
          return { guid: 'real-plain', dateCreated: 2_000, dateDelivered: null };
        }),
        {
          fileExists: async () => {
            fileChecks += 1;
            return true;
          },
          upload: async () => {
            uploads += 1;
            return { guid: 'must-not-send' };
          },
        },
        2_000_000,
      ),
    ).resolves.toEqual({ eligible: 5, sent: 1 });

    expect(posts).toEqual([
      expect.objectContaining({ text: 'plain text survives', method: 'apple-script' }),
    ]);
    expect({ fileChecks, uploads }).toEqual({ fileChecks: 0, uploads: 0 });
    for (const tempGuid of retired) {
      expect(attemptsOf(raw, tempGuid)).toBe(OUTGOING_MAX_ATTEMPTS);
      expect(stateOf(raw, tempGuid)).toBe('error');
    }
  });

  it('retires a marker-only recovered iMessage effect as delivery-unconfirmed without replay', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'any;-;+15551234567');
    await insertOutgoingText(db, {
      tempGuid: 'temp-effect-recovery',
      chatGuid: 'any;-;+15551234567',
      text: 'possibly delivered',
      oneShotEffect: true,
      now: 1_000,
    });
    raw
      .prepare(
        `UPDATE outgoing_queue
            SET created_at = 0, next_retry_at = 0
          WHERE temp_guid = 'temp-effect-recovery'`,
      )
      .run();

    await expect(runOutgoingQueue(db, noRequestHttp, noAttachmentIo, 2_000_000)).resolves.toEqual({
      eligible: 1,
      sent: 0,
    });

    expect(attemptsOf(raw, 'temp-effect-recovery')).toBe(OUTGOING_MAX_ATTEMPTS);
    expect(
      raw
        .prepare(
          `SELECT send_state AS state, error, error_message AS detail
             FROM messages WHERE guid = 'temp-effect-recovery'`,
        )
        .get(),
    ).toEqual({
      state: 'error',
      error: ClientErrorCode.effectDeliveryUnconfirmed,
      detail:
        'This effect message may have been delivered. Check Messages before sending a new copy.',
    });
    await expect(claimFailedOutgoingForRetry(db, 'temp-effect-recovery')).resolves.toMatchObject({
      claim: 'unsendable',
    });
  });

  it('leaves a row alone while this process is still uploading it', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'any;-;+15551234567');
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-slow-upload',
      attachmentGuid: 'temp-slow-upload-att',
      chatGuid: 'any;-;+15551234567',
      localPath: 'file:///slow-photo.jpg',
      mimeType: 'image/jpeg',
      transferName: 'slow-photo.jpg',
      totalBytes: 8_000_000,
      now: 1_000,
      imessageAttachmentV1: true,
    });
    raw.prepare('UPDATE outgoing_queue SET created_at = 0, next_retry_at = 0').run();
    const upload = jest.fn(async () => ({ guid: 'must-not-send' }));
    const io: OutgoingQueueIO = { upload, fileExists: async () => true };
    // Well past the 60 s grace window, but the live send is still uploading on a slow link.
    const release = uploadRegistry.add('temp-slow-upload', {
      cancel: () => undefined,
      settled: Promise.resolve(),
    });
    try {
      await runOutgoingQueue(db, noRequestHttp, io, 2_000_000);

      expect(upload).not.toHaveBeenCalled();
      expect(attemptsOf(raw, 'temp-slow-upload')).toBe(0);
      expect(stateOf(raw, 'temp-slow-upload')).toBe('sending');
    } finally {
      release();
    }

    // Once that upload ends without settling the row, the drain takes it over as before.
    await runOutgoingQueue(db, noRequestHttp, io, 2_000_000);
    expect(attemptsOf(raw, 'temp-slow-upload')).toBe(OUTGOING_MAX_ATTEMPTS);
    expect(errorOf(raw, 'temp-slow-upload')).toBe(ClientErrorCode.attachmentDeliveryUnconfirmed);
  });

  it('retires a recovered iMessage contact card as delivery-unconfirmed without a failure notice', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'any;-;+15551234567');
    await insertOutgoingContact(db, {
      tempGuid: 'temp-contact-recovery',
      chatGuid: 'any;-;+15551234567',
      text: 'Ada Lovelace',
      contact: { firstName: 'Ada', lastName: 'Lovelace' },
      now: 1_000,
    });
    raw
      .prepare(
        `UPDATE outgoing_queue
            SET created_at = 0, next_retry_at = 0
          WHERE temp_guid = 'temp-contact-recovery'`,
      )
      .run();

    await expect(runOutgoingQueue(db, noRequestHttp, noAttachmentIo, 2_000_000)).resolves.toEqual({
      eligible: 1,
      sent: 0,
    });

    expect(attemptsOf(raw, 'temp-contact-recovery')).toBe(OUTGOING_MAX_ATTEMPTS);
    expect(
      raw
        .prepare(
          `SELECT send_state AS state, error, error_message AS detail
             FROM messages WHERE guid = 'temp-contact-recovery'`,
        )
        .get(),
    ).toEqual({
      state: 'error',
      error: ClientErrorCode.contactDeliveryUnconfirmed,
      detail:
        'This contact card may have been delivered. Check Messages before sending a new copy.',
    });
    expect(mockNotifyFailedSend).not.toHaveBeenCalled();
  });

  it('refuses manual replay of a marker-only iMessage effect before mutating its ladder', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'any;-;+15551234567');
    await insertOutgoingText(db, {
      tempGuid: 'temp-effect-manual',
      chatGuid: 'any;-;+15551234567',
      text: 'must not become plain text',
      oneShotEffect: true,
      now: 1_000,
    });
    raw
      .prepare(
        `UPDATE messages
            SET send_state = 'error', error = 500
          WHERE guid = 'temp-effect-manual'`,
      )
      .run();

    await expect(claimFailedOutgoingForRetry(db, 'temp-effect-manual')).resolves.toEqual({
      claim: 'unsendable',
    });
    expect(attemptsOf(raw, 'temp-effect-manual')).toBe(0);
    expect(stateOf(raw, 'temp-effect-manual')).toBe('error');
  });

  it('retires only a marked recovered iMessage image as delivery-unconfirmed without replay', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'any;-;+15551234567');
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-one-shot-image',
      attachmentGuid: 'temp-one-shot-image-att',
      chatGuid: 'any;-;+15551234567',
      localPath: 'file:///keep-this-image.jpg',
      mimeType: 'image/jpeg',
      transferName: 'keep-this-image.jpg',
      totalBytes: 10,
      now: 1_000,
      imessageAttachmentV1: true,
    });
    raw.prepare('UPDATE outgoing_queue SET created_at = 0, next_retry_at = 0').run();
    const upload = jest.fn(async () => ({ guid: 'must-not-send' }));
    const fileExists = jest.fn(async () => true);

    await expect(
      runOutgoingQueue(db, noRequestHttp, { upload, fileExists }, 2_000_000),
    ).resolves.toEqual({ eligible: 1, sent: 0 });

    expect(upload).not.toHaveBeenCalled();
    expect(fileExists).not.toHaveBeenCalled();
    expect(attemptsOf(raw, 'temp-one-shot-image')).toBe(OUTGOING_MAX_ATTEMPTS);
    expect(
      raw
        .prepare(
          `SELECT send_state AS state, error, error_message AS detail
             FROM messages WHERE guid = 'temp-one-shot-image'`,
        )
        .get(),
    ).toEqual({
      state: 'error',
      error: ClientErrorCode.attachmentDeliveryUnconfirmed,
      detail: 'Delivery may have occurred. Check Messages before sending a new copy.',
    });
    expect(
      (raw.prepare('SELECT local_path AS path FROM attachments').get() as { path: string }).path,
    ).toBe('file:///keep-this-image.jpg');
    expect(mockNotifyFailedSend).not.toHaveBeenCalled();
  });

  it('retries a whole-message RCS reaction without inventing Apple part topology', async () => {
    const { db, raw } = await createTestDb();
    const targetGuid = rcsMessageGuid('target-1');
    await seedWholeMessageRcsTarget(db, targetGuid);
    const chatId = await getChatIdByGuid(db, RCS_CHAT_GUID);
    await insertOutgoingReaction(db, {
      tempGuid: 'temp-rcs-reaction',
      chatId: chatId!,
      chatGuid: RCS_CHAT_GUID,
      targetGuid,
      reaction: 'love',
      partIndex: 0,
      now: 1_000,
    });
    raw
      .prepare("UPDATE messages SET send_state='error', error=500 WHERE guid='temp-rcs-reaction'")
      .run();
    raw
      .prepare(
        "UPDATE outgoing_queue SET attempts=1, next_retry_at=0 WHERE temp_guid='temp-rcs-reaction'",
      )
      .run();
    let body: Record<string, unknown> | undefined;

    await expect(
      runOutgoingQueue(
        db,
        fakeHttp(async (json) => {
          body = json as Record<string, unknown>;
          return { guid: 'real-rcs-reaction', dateCreated: 2_000, dateDelivered: null };
        }),
        noAttachmentIo,
        2_000,
        undefined,
        undefined,
        undefined,
        { allowsLegacyPartZero: false, isCurrent: () => true },
        rcsAvailable,
      ),
    ).resolves.toEqual({ eligible: 1, sent: 1 });

    expect(body).toMatchObject({
      messageGuid: targetGuid,
      reactionType: 'love',
      partIndex: 0,
    });
    expect(queueCount(raw)).toBe(0);
  });

  it('retires recovered targeted RCS text, contact, and attachment rows without transport work', async () => {
    const { db, raw } = await createTestDb();
    const targetGuid = rcsMessageGuid('reply-target');
    await seedExactRcsTextTarget(db, targetGuid, 4);
    const chatId = await getChatIdByGuid(db, RCS_CHAT_GUID);
    await insertOutgoingText(db, {
      tempGuid: 'temp-rcs-text-reply',
      chatId: chatId!,
      chatGuid: RCS_CHAT_GUID,
      text: 'text',
      selectedMessageGuid: targetGuid,
      partIndex: 4,
      now: 1_000,
    });
    await insertOutgoingContact(db, {
      tempGuid: 'temp-rcs-contact-reply',
      chatId: chatId!,
      chatGuid: RCS_CHAT_GUID,
      text: 'Ada',
      contact: { firstName: 'Ada' },
      selectedMessageGuid: targetGuid,
      partIndex: 4,
      now: 1_000,
    });
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-rcs-attachment-reply',
      attachmentGuid: 'temp-rcs-attachment-reply-att',
      chatId: chatId!,
      chatGuid: RCS_CHAT_GUID,
      localPath: 'file:///must-not-open.jpg',
      mimeType: 'image/jpeg',
      transferName: 'must-not-open.jpg',
      totalBytes: 10,
      selectedMessageGuid: targetGuid,
      partIndex: 4,
      now: 1_000,
    });
    raw
      .prepare(
        `UPDATE messages
            SET send_state = 'error', error = 500
          WHERE guid IN ('temp-rcs-text-reply', 'temp-rcs-contact-reply',
                         'temp-rcs-attachment-reply')`,
      )
      .run();
    raw
      .prepare(
        `UPDATE outgoing_queue
            SET attempts = 1, next_retry_at = 0
          WHERE temp_guid IN ('temp-rcs-text-reply', 'temp-rcs-contact-reply',
                              'temp-rcs-attachment-reply')`,
      )
      .run();
    let posts = 0;
    let fileChecks = 0;
    let uploads = 0;

    await expect(
      runOutgoingQueue(
        db,
        fakeHttp(async () => {
          posts += 1;
          return { guid: 'must-not-send' };
        }),
        {
          fileExists: async () => {
            fileChecks += 1;
            return true;
          },
          upload: async () => {
            uploads += 1;
            return { guid: 'must-not-send' };
          },
        },
        2_000,
        undefined,
        undefined,
        undefined,
        undefined,
        rcsAvailable,
      ),
    ).resolves.toEqual({ eligible: 3, sent: 0 });

    expect({ posts, fileChecks, uploads }).toEqual({ posts: 0, fileChecks: 0, uploads: 0 });
    for (const tempGuid of [
      'temp-rcs-text-reply',
      'temp-rcs-contact-reply',
      'temp-rcs-attachment-reply',
    ]) {
      expect(attemptsOf(raw, tempGuid)).toBe(OUTGOING_MAX_ATTEMPTS);
      expect(stateOf(raw, tempGuid)).toBe('error');
    }
  });

  it('keeps a targeted RCS row intact at manual claim without current pairing proof', async () => {
    const { db, raw } = await createTestDb();
    const targetGuid = rcsMessageGuid('legacy-reply-target');
    await seedWholeMessageRcsTarget(db, targetGuid);
    const chatId = await getChatIdByGuid(db, RCS_CHAT_GUID);
    await insertOutgoingText(db, {
      tempGuid: 'temp-rcs-manual-reply',
      chatId: chatId!,
      chatGuid: RCS_CHAT_GUID,
      text: 'must not send',
      selectedMessageGuid: targetGuid,
      partIndex: 0,
      now: 1_000,
    });
    raw
      .prepare(
        "UPDATE messages SET send_state = 'error', error = 500 WHERE guid = 'temp-rcs-manual-reply'",
      )
      .run();

    await expect(claimFailedOutgoingForRetry(db, 'temp-rcs-manual-reply')).resolves.toEqual({
      claim: 'unsendable',
    });
    expect(attemptsOf(raw, 'temp-rcs-manual-reply')).toBe(0);
    expect(stateOf(raw, 'temp-rcs-manual-reply')).toBe('error');
  });

  it('defensively retires a directly handed-off targeted RCS row without POST', async () => {
    const { db, raw } = await createTestDb();
    const targetGuid = rcsMessageGuid('direct-reply-target');
    await seedWholeMessageRcsTarget(db, targetGuid);
    const chatId = await getChatIdByGuid(db, RCS_CHAT_GUID);
    await insertOutgoingText(db, {
      tempGuid: 'temp-rcs-direct-reply',
      chatId: chatId!,
      chatGuid: RCS_CHAT_GUID,
      text: 'must not send',
      selectedMessageGuid: targetGuid,
      partIndex: 0,
      now: 1_000,
    });
    raw
      .prepare(
        "UPDATE messages SET send_state = 'error', error = 500 WHERE guid = 'temp-rcs-direct-reply'",
      )
      .run();
    raw
      .prepare(
        "UPDATE outgoing_queue SET attempts = 1, next_retry_at = 0 WHERE temp_guid = 'temp-rcs-direct-reply'",
      )
      .run();
    const row = await retryableRow(db, 2_000);
    let posts = 0;

    await expect(
      resendOutgoingRow(
        db,
        fakeHttp(async () => {
          posts += 1;
          return { guid: 'must-not-send' };
        }),
        noAttachmentIo,
        row,
        () => 2_000,
        undefined,
        undefined,
        undefined,
        undefined,
        rcsAvailable,
      ),
    ).resolves.toBe('unsendable');

    expect(posts).toBe(0);
    expect(attemptsOf(raw, 'temp-rcs-direct-reply')).toBe(OUTGOING_MAX_ATTEMPTS);
    expect(stateOf(raw, 'temp-rcs-direct-reply')).toBe('error');
  });

  it('retires a legacy iMessage reply without waiting for ServerInfo', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await seedLegacyTextTarget(db, 'legacy-target');
    const chatId = await getChatIdByGuid(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-legacy-unknown',
      chatId: chatId!,
      chatGuid: 'c1',
      text: 'wait for capabilities',
      now: 1_000,
      selectedMessageGuid: 'legacy-target',
      partIndex: 0,
    });
    raw.prepare("UPDATE messages SET send_state='error' WHERE guid='temp-legacy-unknown'").run();
    raw
      .prepare(
        "UPDATE outgoing_queue SET attempts=1, next_retry_at=0 WHERE temp_guid='temp-legacy-unknown'",
      )
      .run();
    let posts = 0;

    await expect(
      runOutgoingQueue(
        db,
        fakeHttp(async () => {
          posts += 1;
          return { guid: 'must-not-send' };
        }),
        noAttachmentIo,
        2_000,
      ),
    ).resolves.toEqual({ eligible: 1, sent: 0 });

    expect(posts).toBe(0);
    expect(attemptsOf(raw, 'temp-legacy-unknown')).toBe(OUTGOING_MAX_ATTEMPTS);
    expect(stateOf(raw, 'temp-legacy-unknown')).toBe('error');
  });

  it('retires an iMessage reply even when its promoted target alias is still valid', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await seedExactTextTarget(db, 'temp-target-alias', 2);
    const chatId = await getChatIdByGuid(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-reply-alias',
      chatId: chatId!,
      chatGuid: 'c1',
      text: 'reply after promotion',
      now: 1_000,
      selectedMessageGuid: 'temp-target-alias',
      partIndex: 2,
    });
    raw
      .prepare("UPDATE messages SET guid='real-target-alias' WHERE guid='temp-target-alias'")
      .run();
    raw
      .prepare(
        "INSERT INTO message_guid_aliases(alias_guid, canonical_guid) VALUES ('temp-target-alias', 'real-target-alias')",
      )
      .run();
    raw.prepare("UPDATE messages SET send_state='error' WHERE guid='temp-reply-alias'").run();
    raw
      .prepare(
        "UPDATE outgoing_queue SET attempts=1, next_retry_at=0 WHERE temp_guid='temp-reply-alias'",
      )
      .run();
    let posted: Record<string, unknown> | undefined;

    await runOutgoingQueue(
      db,
      fakeHttp(async (body) => {
        posted = body as Record<string, unknown>;
        return { guid: 'real-reply-alias', dateCreated: 2_000, dateDelivered: null };
      }),
      noAttachmentIo,
      2_000,
    );

    expect(posted).toBeUndefined();
    expect(attemptsOf(raw, 'temp-reply-alias')).toBe(OUTGOING_MAX_ATTEMPTS);
    expect(stateOf(raw, 'temp-reply-alias')).toBe('error');
  });

  it('retires an iMessage contact reply without posting its canonical target', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await seedExactTextTarget(db, 'temp-contact-target', 2);
    const chatId = await getChatIdByGuid(db, 'c1');
    await insertOutgoingContact(db, {
      tempGuid: 'temp-contact-reply',
      chatId: chatId!,
      chatGuid: 'c1',
      text: 'Ada Lovelace',
      contact: { firstName: 'Ada', lastName: 'Lovelace' },
      now: 1_000,
      selectedMessageGuid: 'temp-contact-target',
      partIndex: 2,
      threadOriginatorGuid: 'temp-contact-target',
    });
    raw
      .prepare("UPDATE messages SET guid='real-contact-target' WHERE guid='temp-contact-target'")
      .run();
    raw
      .prepare(
        "INSERT INTO message_guid_aliases(alias_guid, canonical_guid) VALUES ('temp-contact-target', 'real-contact-target')",
      )
      .run();
    raw.prepare("UPDATE messages SET send_state='error' WHERE guid='temp-contact-reply'").run();
    raw
      .prepare(
        "UPDATE outgoing_queue SET attempts=1, next_retry_at=0 WHERE temp_guid='temp-contact-reply'",
      )
      .run();
    let posted: Record<string, unknown> | undefined;

    await runOutgoingQueue(
      db,
      fakeHttp(async (body) => {
        posted = body as Record<string, unknown>;
        return { guid: 'real-contact-reply', dateCreated: 2_000, dateDelivered: null };
      }),
      noAttachmentIo,
      2_000,
    );

    expect(posted).toBeUndefined();
    expect(attemptsOf(raw, 'temp-contact-reply')).toBe(OUTGOING_MAX_ATTEMPTS);
    expect(stateOf(raw, 'temp-contact-reply')).toBe('error');
  });

  it('retires a targeted retry without POST when sync has removed its exact part', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await seedExactTextTarget(db, 'reply-target', 2);
    const chatId = await getChatIdByGuid(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-stale-target',
      chatId: chatId!,
      chatGuid: 'c1',
      text: 'must not post',
      now: 1_000,
      selectedMessageGuid: 'reply-target',
      partIndex: 2,
    });
    raw
      .prepare(
        `UPDATE messages
            SET date_retracted = 1_500,
                retraction_state = 'partial',
                message_part_topology = ?
          WHERE guid = 'reply-target'`,
      )
      .run(
        JSON.stringify({
          complete: true,
          originalPartIndexes: [2, 3],
          currentParts: [{ index: 3, kind: 'text' }],
          attachmentOwnership: [],
        }),
      );
    raw.prepare("UPDATE messages SET send_state = 'error' WHERE guid = 'temp-stale-target'").run();
    raw
      .prepare(
        "UPDATE outgoing_queue SET attempts = 1, next_retry_at = 0 WHERE temp_guid = 'temp-stale-target'",
      )
      .run();
    let posts = 0;

    await expect(
      runOutgoingQueue(
        db,
        fakeHttp(async () => {
          posts += 1;
          return { guid: 'must-not-send' };
        }),
        noAttachmentIo,
        2_000,
      ),
    ).resolves.toEqual({ eligible: 1, sent: 0 });
    expect(posts).toBe(0);
    expect(attemptsOf(raw, 'temp-stale-target')).toBe(OUTGOING_MAX_ATTEMPTS);
    expect(stateOf(raw, 'temp-stale-target')).toBe('error');
  });

  it('applies an explicit oldest-first cap to a background drain', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await strandedText(db, raw, 'c1', 'temp-third', 300);
    await strandedText(db, raw, 'c1', 'temp-first', 100);
    await strandedText(db, raw, 'c1', 'temp-second', 200);

    const rows = await listRetryableOutgoing(db, 1_000_000, 2);

    expect(rows.map((row) => row.tempGuid)).toEqual(['temp-first', 'temp-second']);
    expect(await listRetryableOutgoing(db, 1_000_000, 0)).toEqual([]);
  });

  it('retries a stranded send to success and clears the queue row', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const now = 10_000_000;
    await strandedText(db, raw, 'c1', 'temp-a', now - 200_000);

    const res = await runOutgoingQueue(db, okHttp(now), noAttachmentIo, now);
    expect(res).toEqual({ eligible: 1, sent: 1 });
    expect(queueCount(raw)).toBe(0); // reconciled + dequeued
    expect(stateOf(raw, 'real-1')).toBe('sent'); // temp promoted to the real guid
  });

  it('retires persisted iMessage subject and mention payloads without HTTP', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const now = 10_000_000;
    const chatId = await getChatIdByGuid(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-subj',
      chatId: chatId!,
      chatGuid: 'c1',
      text: 'body',
      now: now - 200_000,
      subject: 'Important',
      mentions: [{ start: 0, length: 4, address: 'a@b.com' }],
    });
    raw
      .prepare('UPDATE outgoing_queue SET created_at = ? WHERE temp_guid = ?')
      .run(now - 200_000, 'temp-subj');

    let wire: Record<string, unknown> | undefined;
    const http = fakeHttp(async (json) => {
      wire = json as Record<string, unknown>;
      return { guid: 'real-subj', dateCreated: now, dateDelivered: null };
    });
    expect(await runOutgoingQueue(db, http, noAttachmentIo, now)).toEqual({
      eligible: 1,
      sent: 0,
    });
    expect(wire).toBeUndefined();
    expect(attemptsOf(raw, 'temp-subj')).toBe(OUTGOING_MAX_ATTEMPTS);
    expect(stateOf(raw, 'temp-subj')).toBe('error');
  });

  it('does not touch a FRESH in-flight row (within the grace window)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const now = 10_000_000;
    const chatId = await getChatIdByGuid(db, 'c1');
    // created_at defaults to ~real-now; pass now far in the PAST so the row looks fresh.
    await insertOutgoingText(db, {
      tempGuid: 'temp-fresh',
      chatId: chatId!,
      chatGuid: 'c1',
      text: 'hi',
      now,
    });
    const res = await runOutgoingQueue(db, okHttp(now), noAttachmentIo, now);
    expect(res.eligible).toBe(0);
    expect(queueCount(raw)).toBe(1); // left for the in-flight UI send
  });

  it('schedules a backoff retry on failure, then succeeds once it elapses', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const t = 10_000_000;
    await strandedText(db, raw, 'c1', 'temp-b', t - 200_000);

    // First attempt fails → attempts=1, next_retry_at = t + 30s, message errored.
    expect(await runOutgoingQueue(db, failHttp(), noAttachmentIo, t)).toEqual({
      eligible: 1,
      sent: 0,
    });
    expect(stateOf(raw, 'temp-b')).toBe('error');
    expect(queueCount(raw)).toBe(1);

    // Before the backoff elapses → not eligible.
    expect((await listRetryableOutgoing(db, t + 10_000)).length).toBe(0);

    // After the backoff → retried, and this time it succeeds.
    const res = await runOutgoingQueue(db, okHttp(t + 31_000), noAttachmentIo, t + 31_000);
    expect(res.sent).toBe(1);
    expect(queueCount(raw)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[queue] failed for chat c1 (code 500, HTTP 500): boom');
    warn.mockRestore();
  });

  it('retires a permanently-failing row after the attempt cap (no infinite retry)', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    let t = 10_000_000;
    await strandedText(db, raw, 'c1', 'temp-c', t - 200_000);

    // Drive 5 failures, advancing past each backoff window.
    for (let i = 0; i < 5; i++) {
      await runOutgoingQueue(db, failHttp(), noAttachmentIo, t);
      t += 3_700_000; // past the max backoff so the next attempt is eligible
    }
    // Capped: no longer eligible, message stays errored, row retired (still present).
    expect((await listRetryableOutgoing(db, t)).length).toBe(0);
    expect(stateOf(raw, 'temp-c')).toBe('error');
    expect(warn.mock.calls).toEqual(
      Array.from({ length: 5 }, () => ['[queue] failed for chat c1 (code 500, HTTP 500): boom']),
    );
    warn.mockRestore();
  });

  it('REGRESSION: a retry SUCCESS on the RCS tempGuid-echo ack flips error→sent and clears the queue (no duplicate re-sends)', async () => {
    // The swallow bug: a retried row is 'error' from its last failure, and the RCS ack echoes
    // our own tempGuid, which reconciles via markOutgoingSentNoGuid — whose sticky-error guard
    // refused to touch an 'error' row AND left the queue row alive. The retry's success was
    // invisible: bubble stayed errored, attempts never bumped, and the queue re-sent the same
    // message on EVERY later drain (duplicate texts once the server idempotency TTL lapsed).
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await strandedText(db, raw, 'c1', 'temp-rcs', 1000);
    raw.prepare("UPDATE messages SET send_state='error', error=500 WHERE guid='temp-rcs'").run();
    raw
      .prepare("UPDATE outgoing_queue SET attempts=1, next_retry_at=0 WHERE temp_guid='temp-rcs'")
      .run();

    const res = await runOutgoingQueue(db, rcsEchoHttp(), noAttachmentIo, 2_000_000);
    expect(res).toEqual({ eligible: 1, sent: 1 });
    // Identity stays the tempGuid (the real rcs-<id> arrives later on the fanout), but the
    // bubble is 'sent' and the queue row is GONE — nothing left to re-send.
    expect(stateOf(raw, 'temp-rcs')).toBe('sent');
    expect(queueCount(raw)).toBe(0);
  });
});

describe('runOutgoingQueue — attachment resend', () => {
  it('does not turn an A file-check into a B upload after Disconnect + reconnect', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await seedFailedAttachment(db, raw, 'temp-account-race');

    let account = 'A';
    let current = true;
    const lease: RealtimeDeliveryLease = { generation: 7, isCurrent: () => current };
    const uploadedAccounts: string[] = [];
    const io = fakeIo({
      fileExists: async () => {
        // Exact production race: A's native stat is outstanding, Forget retires A, then B connects
        // before the promise resumes. Without the post-await lease check, upload snapshots B.
        current = false;
        account = 'B';
        return true;
      },
      upload: async () => {
        uploadedAccounts.push(account);
        return { guid: 'should-not-send' };
      },
    });

    await expect(
      runOutgoingQueue(
        db,
        noRequestHttp,
        io.io,
        2_000_000,
        lease,
        undefined,
        undefined,
        undefined,
        rcsAvailable,
      ),
    ).resolves.toEqual({
      eligible: 1,
      sent: 0,
    });
    expect(uploadedAccounts).toEqual([]);
    expect(io.captured).toBeUndefined();
    // No B-account failure/reconcile write ran after revocation. Forget owns the eventual wipe.
    expect(stateOf(raw, 'temp-account-race')).toBe('sending');
  });

  it('re-uploads a failed picture and its text under the same retry identity', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await seedFailedAttachment(db, raw, 'temp-pic', {
      text: 'caption',
    });

    let transportPinned = false;
    let transportChecked = false;
    const pinnedHttp = {
      assertTransportCurrent: () => {
        transportChecked = true;
      },
    } as unknown as HttpClient;
    const sourceHttp = {
      pinTransport: () => {
        transportPinned = true;
        return pinnedHttp;
      },
    } as unknown as HttpClient;
    const up = fakeIo({
      fileExists: async () => {
        expect(transportPinned).toBe(true);
        return true;
      },
      upload: async (args) => {
        expect(transportChecked).toBe(true);
        expect(args.http).toBe(pinnedHttp);
        return { guid: 'real-pic', viaPrivateApi: true };
      },
    });
    const res = await runOutgoingQueue(
      db,
      sourceHttp,
      up.io,
      2_000_000,
      undefined,
      undefined,
      undefined,
      undefined,
      rcsAvailable,
    );
    expect(res).toEqual({ eligible: 1, sent: 1 });
    // The re-upload streams the ORIGINAL on-disk file under the ORIGINAL tempGuid (so the
    // server's idempotency cache can absorb an ack-lost duplicate).
    expect(up.captured).toMatchObject({
      chatGuid: RCS_ATTACHMENT_CHAT_GUID,
      tempGuid: 'temp-pic',
      name: 'pic.jpg',
      uri: 'file:///pic.jpg',
      mimeType: 'image/jpeg',
      text: 'caption',
    });
    expect(up.captured?.timeoutMs).toBeUndefined(); // foreground/ordinary drains stay unbounded
    // The same durable payload succeeds, promotes to the real iMessage guid, and clears its queue.
    expect(stateOf(raw, 'temp-pic')).toBeUndefined();
    expect(stateOf(raw, 'real-pic')).toBe('sent');
    expect(queueCount(raw)).toBe(0);
    expect((raw.prepare('SELECT local_path lp FROM attachments').get() as { lp: string }).lp).toBe(
      'file:///pic.jpg',
    );
  });

  it('passes the remainder of one shared attachment deadline through to the uploader', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await seedFailedAttachment(db, raw, 'temp-deadline');
    jest.useFakeTimers();
    jest.setSystemTime(2_000_000);
    try {
      const up = fakeIo({
        fileExists: async () => {
          jest.advanceTimersByTime(250);
          // A manual/NTP wall-clock jump must not restore spent deadline budget.
          jest.setSystemTime(1_000_000);
          return true;
        },
        upload: async (args) => {
          jest.setSystemTime(2_000_250);
          return { guid: args.tempGuid, viaPrivateApi: false };
        },
      });

      await expect(
        runOutgoingQueue(
          db,
          noRequestHttp,
          up.io,
          2_000_000,
          undefined,
          1,
          60_000,
          undefined,
          rcsAvailable,
          undefined,
          undefined,
          RCS_PROVIDER_EPOCH,
        ),
      ).resolves.toEqual({ eligible: 1, sent: 1 });
      expect(up.captured?.timeoutMs).toBe(59_750);
    } finally {
      jest.useRealTimers();
    }
  });

  it('passes the exact queue abort signal through to the attachment uploader', async () => {
    const { db, raw } = await createTestDb();
    await seedFailedAttachment(db, raw, 'temp-abort-signal');
    const controller = new AbortController();
    const up = fakeIo({
      upload: async (args) => ({ guid: args.tempGuid, viaPrivateApi: false }),
    });

    await expect(
      runOutgoingQueue(
        db,
        noRequestHttp,
        up.io,
        2_000_000,
        undefined,
        1,
        undefined,
        undefined,
        rcsAvailable,
        controller.signal,
        undefined,
        RCS_PROVIDER_EPOCH,
      ),
    ).resolves.toEqual({ eligible: 1, sent: 1 });
    expect(up.captured?.signal).toBe(controller.signal);
  });

  it('times out the queue-level native file check and bumps one retry backoff', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await seedFailedAttachment(db, raw, 'temp-stat-timeout');
    let finishFileCheck: (exists: boolean) => void = () => undefined;
    let enteredFileCheck!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredFileCheck = resolve;
    });
    const up = fakeIo({
      fileExists: () => {
        enteredFileCheck();
        return new Promise<boolean>((resolve) => {
          finishFileCheck = resolve;
        });
      },
      upload: async () => ({ guid: 'must-not-upload' }),
    });

    jest.useFakeTimers();
    jest.setSystemTime(2_000_000);
    try {
      const run = runOutgoingQueue(
        db,
        noRequestHttp,
        up.io,
        2_000_000,
        undefined,
        1,
        60_000,
        undefined,
        rcsAvailable,
        undefined,
        undefined,
        RCS_PROVIDER_EPOCH,
      );
      await entered;
      jest.advanceTimersByTime(60_000);

      await expect(run).resolves.toEqual({ eligible: 1, sent: 0 });
      expect(up.captured).toBeUndefined();
      expect(stateOf(raw, 'temp-stat-timeout')).toBe('error');
      expect(errorOf(raw, 'temp-stat-timeout')).toBe(10003);
      expect(attemptsOf(raw, 'temp-stat-timeout')).toBe(2);
      expect(warn).toHaveBeenCalledWith(
        `[queue] failed for chat ${RCS_ATTACHMENT_CHAT_GUID} (code 10003): Attachment retry timed out`,
      );
    } finally {
      finishFileCheck(true);
      await Promise.resolve();
      jest.useRealTimers();
      warn.mockRestore();
    }
  });

  it('a failed re-upload bumps attempts + reschedules backoff (bubble stays errored)', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await seedFailedAttachment(db, raw, 'temp-pic2');

    const up = fakeIo({
      upload: async () => {
        throw new ApiError('server_error', 'bridge down', 502);
      },
    });
    const res = await runOutgoingQueue(
      db,
      noRequestHttp,
      up.io,
      2_000_000,
      undefined,
      undefined,
      undefined,
      undefined,
      rcsAvailable,
    );
    expect(res).toEqual({ eligible: 1, sent: 0 });
    expect(stateOf(raw, 'temp-pic2')).toBe('error');
    expect(attemptsOf(raw, 'temp-pic2')).toBe(2);
    expect(queueCount(raw)).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `[queue] failed for chat ${RCS_ATTACHMENT_CHAT_GUID} (code 10002, HTTP 502): bridge down`,
    );
    warn.mockRestore();
  });

  it('retires immediately when the local file is GONE (no attempt burn; bubble keeps its error badge)', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await seedFailedAttachment(db, raw, 'temp-gone');

    let fileCheckRanInsideTransaction = true;
    const up = fakeIo({
      fileExists: async () => {
        fileCheckRanInsideTransaction = raw.inTransaction;
        return false;
      },
    });
    const res = await runOutgoingQueue(
      db,
      noRequestHttp,
      up.io,
      2_000_000,
      undefined,
      undefined,
      undefined,
      undefined,
      rcsAvailable,
    );
    expect(res).toEqual({ eligible: 1, sent: 0 });
    expect(fileCheckRanInsideTransaction).toBe(false);
    expect(up.captured).toBeUndefined(); // never attempted an upload
    // Retired: attempts jumped to the cap, so it is never eligible again — even far in the future.
    expect(attemptsOf(raw, 'temp-gone')).toBe(OUTGOING_MAX_ATTEMPTS);
    expect((await listRetryableOutgoing(db, 9_999_999_999)).length).toBe(0);
    expect(stateOf(raw, 'temp-gone')).toBe('error');
    expect(queueCount(raw)).toBe(1); // row kept (cancellable / visible to diagnostics)
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[queue] attachment retry has no local file — retiring');
    expect(mockNotifyFailedSend).toHaveBeenCalledWith(
      db,
      RCS_ATTACHMENT_CHAT_GUID,
      'temp-gone',
      undefined,
    );
    warn.mockRestore();
  });

  it('retires an UNKNOWN kind instead of claiming-and-skipping it forever (the old zombie)', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await strandedText(db, raw, 'c1', 'temp-z', 1000);
    raw
      .prepare(
        "UPDATE outgoing_queue SET kind='wormhole', next_retry_at=0 WHERE temp_guid='temp-z'",
      )
      .run();
    raw.prepare("UPDATE outgoing_queue SET attempts=1 WHERE temp_guid='temp-z'").run();

    const res = await runOutgoingQueue(db, noRequestHttp, noAttachmentIo, 2_000_000);
    expect(res).toEqual({ eligible: 1, sent: 0 });
    expect(attemptsOf(raw, 'temp-z')).toBe(OUTGOING_MAX_ATTEMPTS);
    expect((await listRetryableOutgoing(db, 9_999_999_999)).length).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[queue] unknown outgoing kind 'wormhole' — retiring");
    expect(mockNotifyFailedSend).toHaveBeenCalledWith(db, 'c1', 'temp-z', undefined);
    warn.mockRestore();
  });
});

describe('outgoing queue — account revocation while a DB commit waits', () => {
  it('holds the account drain for the whole automatic retry POST', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await strandedText(db, raw, 'c1', 'temp-whole-retry', 1_000);
    let finishPost!: (value: { guid: string }) => void;
    const post = new Promise<{ guid: string }>((resolve) => {
      finishPost = resolve;
    });
    let postStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      postStarted = resolve;
    });
    const accountA = captureRealtimeDeliveryLease();
    const retry = runOutgoingQueue(
      db,
      fakeHttp(async () => {
        postStarted();
        return post;
      }),
      noAttachmentIo,
      2_000_000,
      accountA,
    );
    let drain: Promise<void> | undefined;

    try {
      await started;
      drain = pauseRealtimeDeliveries();
      let drainSettled = false;
      void drain.then(() => {
        drainSettled = true;
      });
      await Promise.resolve();
      expect(drainSettled).toBe(false);
      expect(accountA.isCurrent()).toBe(false);

      resumeRealtimeDeliveries();
      const accountB = captureRealtimeDeliveryLease();
      expect(accountB.isCurrent()).toBe(true);
      expect(accountA.isCurrent()).toBe(false);

      finishPost({ guid: 'real-old-account' });
      await expect(retry).resolves.toEqual({ eligible: 1, sent: 0 });
      await expect(drain).resolves.toBeUndefined();
      expect(stateOf(raw, 'temp-whole-retry')).toBe('sending');
      expect(stateOf(raw, 'real-old-account')).toBeUndefined();
      expect(queueCount(raw)).toBe(1);
    } finally {
      finishPost({ guid: 'real-old-account' });
      await Promise.allSettled([retry, ...(drain ? [drain] : [])]);
      await pauseRealtimeDeliveries();
      resumeRealtimeDeliveries();
    }
  });

  it('does not claim a queued row after Disconnect revokes its admitted account lease', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await strandedText(db, raw, 'c1', 'temp-guard-claim', 1_000);
    raw
      .prepare("UPDATE messages SET send_state='error', error=502 WHERE guid='temp-guard-claim'")
      .run();
    raw
      .prepare(
        "UPDATE outgoing_queue SET attempts=1, next_retry_at=0 WHERE temp_guid='temp-guard-claim'",
      )
      .run();

    const held = await holdDbTransaction(db);
    const account = revocableLease();
    let posts = 0;
    const pending = runOutgoingQueue(
      db,
      fakeHttp(async () => {
        posts += 1;
        return { guid: 'real-guard-claim' };
      }),
      noAttachmentIo,
      2_000_000,
      account.lease,
    );
    // The outer retry admission adds one check ahead of the body's existing entry checks; five
    // means the inner tracked claim is admitted and synchronously waiting behind the held mutex.
    await account.waitForChecks(5);
    account.revoke();
    held.release();
    await held.finished;

    await expect(pending).resolves.toEqual({ eligible: 1, sent: 0 });
    expect(posts).toBe(0);
    expect(stateOf(raw, 'temp-guard-claim')).toBe('error');
    expect(attemptsOf(raw, 'temp-guard-claim')).toBe(1);
  });

  it('rolls back a mid-claim retirement before HTTP and lets a fresh account retry once', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const tempGuid = 'temp-guard-mid-claim';
    await strandedText(db, raw, 'c1', tempGuid, 1_000);
    raw
      .prepare(
        "UPDATE messages SET send_state='error', error=502, error_message='preserve this detail' WHERE guid=?",
      )
      .run(tempGuid);
    raw
      .prepare('UPDATE outgoing_queue SET attempts=1, next_retry_at=123 WHERE temp_guid=?')
      .run(tempGuid);

    let drain: Promise<void> | undefined;
    let triggerRan = false;
    raw.function('pause_automatic_retry_during_claim', () => {
      triggerRan = true;
      drain = pauseRealtimeDeliveries();
      return 0;
    });
    raw.exec(`
      CREATE TRIGGER pause_automatic_retry_during_claim
      AFTER UPDATE OF send_state ON messages
      WHEN OLD.guid = '${tempGuid}' AND OLD.send_state = 'error' AND NEW.send_state = 'sending'
      BEGIN
        SELECT pause_automatic_retry_during_claim();
      END
    `);

    let posts = 0;
    const oldAccount = captureRealtimeDeliveryLease();
    const http = fakeHttp(async () => {
      posts += 1;
      return { guid: 'real-after-mid-claim' };
    });

    try {
      await expect(
        runOutgoingQueue(db, http, noAttachmentIo, 2_000_000, oldAccount),
      ).resolves.toEqual({ eligible: 1, sent: 0 });
      if (!drain) throw new Error('automatic retry claim did not retire the account lease');
      await drain;

      expect(triggerRan).toBe(true);
      expect(posts).toBe(0);
      expect(raw.inTransaction).toBe(false);
      expect(
        raw
          .prepare(
            'SELECT send_state AS sendState, error, error_message AS errorMessage FROM messages WHERE guid=?',
          )
          .get(tempGuid),
      ).toEqual({ sendState: 'error', error: 502, errorMessage: 'preserve this detail' });
      expect(
        raw
          .prepare(
            'SELECT attempts, next_retry_at AS nextRetryAt FROM outgoing_queue WHERE temp_guid=?',
          )
          .get(tempGuid),
      ).toEqual({ attempts: 1, nextRetryAt: 123 });

      raw.exec('DROP TRIGGER pause_automatic_retry_during_claim');
      resumeRealtimeDeliveries();
      const freshAccount = captureRealtimeDeliveryLease();
      let postRanInsideTransaction = false;
      const freshHttp = fakeHttp(async () => {
        postRanInsideTransaction = raw.inTransaction;
        posts += 1;
        return { guid: 'real-after-mid-claim' };
      });

      await expect(
        runOutgoingQueue(db, freshHttp, noAttachmentIo, 2_000_000, freshAccount),
      ).resolves.toEqual({ eligible: 1, sent: 1 });

      expect(posts).toBe(1);
      expect(postRanInsideTransaction).toBe(false);
      expect(stateOf(raw, 'real-after-mid-claim')).toBe('sent');
      expect(queueCount(raw)).toBe(0);
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS pause_automatic_retry_during_claim');
      if (drain) await drain;
      resumeRealtimeDeliveries();
    }
  });

  it('does not reconcile a real-guid success after Disconnect while its commit is queued', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await strandedText(db, raw, 'c1', 'temp-guard-guid', 1_000);
    const row = await retryableRow(db, 2_000_000);

    const held = await holdDbTransaction(db);
    const account = revocableLease();
    const pending = resendOutgoingRow(
      db,
      okHttp(2_000_000),
      noAttachmentIo,
      row,
      () => 2_000_000,
      account.lease,
    );
    await account.waitForChecks(4);
    account.revoke();
    held.release();
    await held.finished;

    await expect(pending).resolves.toBe('paused');
    expect(stateOf(raw, 'temp-guard-guid')).toBe('sending');
    expect(queueCount(raw)).toBe(1);
    expect(stateOf(raw, 'real-1')).toBeUndefined();
  });

  it('does not reconcile a no-guid success after Disconnect while its commit is queued', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await strandedText(db, raw, 'c1', 'temp-guard-no-guid', 1_000);
    const row = await retryableRow(db, 2_000_000);

    const held = await holdDbTransaction(db);
    const account = revocableLease();
    const pending = resendOutgoingRow(
      db,
      fakeHttp(async () => ({})),
      noAttachmentIo,
      row,
      () => 2_000_000,
      account.lease,
    );
    await account.waitForChecks(4);
    account.revoke();
    held.release();
    await held.finished;

    await expect(pending).resolves.toBe('paused');
    expect(stateOf(raw, 'temp-guard-no-guid')).toBe('sending');
    expect(queueCount(raw)).toBe(1);
  });

  it('does not reconcile a failed POST after Disconnect while its commit is queued', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await strandedText(db, raw, 'c1', 'temp-guard-failure', 1_000);
    const row = await retryableRow(db, 2_000_000);

    const held = await holdDbTransaction(db);
    const account = revocableLease();
    const pending = resendOutgoingRow(
      db,
      failHttp(),
      noAttachmentIo,
      row,
      () => 2_000_000,
      account.lease,
    );
    await account.waitForChecks(4);
    account.revoke();
    held.release();
    await held.finished;

    await expect(pending).resolves.toBe('paused');
    expect(stateOf(raw, 'temp-guard-failure')).toBe('sending');
    expect(attemptsOf(raw, 'temp-guard-failure')).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1); // the network failure was logged before the guarded DB tail
    warn.mockRestore();
  });

  it('does not retire a missing attachment after Disconnect while its commit is queued', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await seedFailedAttachment(db, raw, 'temp-guard-missing');
    const row = await retryableRow(db, 2_000_000);

    const held = await holdDbTransaction(db);
    const account = revocableLease();
    const pending = resendOutgoingRow(
      db,
      noRequestHttp,
      fakeIo({ fileExists: async () => false }).io,
      row,
      () => 2_000_000,
      account.lease,
      undefined,
      undefined,
      undefined,
      rcsAvailable,
    );
    await account.waitForChecks(4);
    account.revoke();
    held.release();
    await held.finished;

    await expect(pending).resolves.toBe('paused');
    expect(stateOf(raw, 'temp-guard-missing')).toBe('error');
    expect(attemptsOf(raw, 'temp-guard-missing')).toBe(1);
    expect(mockNotifyFailedSend).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not retire an unknown kind after Disconnect while its commit is queued', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await strandedText(db, raw, 'c1', 'temp-guard-unknown', 1_000);
    raw
      .prepare(
        "UPDATE outgoing_queue SET kind='wormhole', attempts=1, next_retry_at=0 WHERE temp_guid='temp-guard-unknown'",
      )
      .run();
    const row = await retryableRow(db, 2_000_000);

    const held = await holdDbTransaction(db);
    const account = revocableLease();
    const pending = resendOutgoingRow(
      db,
      noRequestHttp,
      noAttachmentIo,
      row,
      () => 2_000_000,
      account.lease,
    );
    await account.waitForChecks(2);
    account.revoke();
    held.release();
    await held.finished;

    await expect(pending).resolves.toBe('paused');
    expect(stateOf(raw, 'temp-guard-unknown')).toBe('sending');
    expect(attemptsOf(raw, 'temp-guard-unknown')).toBe(1);
    expect(mockNotifyFailedSend).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rolls back a mid-retirement account change before notice and lets a fresh account settle', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const tempGuid = 'temp-retire-mid-owner';
    await strandedText(db, raw, 'c1', tempGuid, 1_000);
    raw
      .prepare('UPDATE outgoing_queue SET kind=?, attempts=1, next_retry_at=0 WHERE temp_guid=?')
      .run('wormhole', tempGuid);
    const row = await retryableRow(db, 2_000_000);

    let drain: Promise<void> | undefined;
    let triggerRan = false;
    raw.function('pause_automatic_retry_during_retirement', () => {
      triggerRan = true;
      drain = pauseRealtimeDeliveries();
      return 0;
    });
    raw.exec(`
      CREATE TRIGGER pause_automatic_retry_during_retirement
      AFTER UPDATE OF send_state ON messages
      WHEN OLD.guid = '${tempGuid}' AND NEW.send_state = 'error' AND NEW.error = 1
      BEGIN
        SELECT pause_automatic_retry_during_retirement();
      END
    `);

    const oldAccount = captureRealtimeDeliveryLease();
    try {
      await expect(
        resendOutgoingRow(db, noRequestHttp, noAttachmentIo, row, () => 2_000_000, oldAccount),
      ).resolves.toBe('paused');
      if (!drain) throw new Error('outgoing retirement did not retire the account lease');
      await drain;

      expect(triggerRan).toBe(true);
      expect(raw.inTransaction).toBe(false);
      expect(attemptsOf(raw, tempGuid)).toBe(1);
      expect(stateOf(raw, tempGuid)).toBe('sending');
      expect(errorOf(raw, tempGuid)).toBe(0);
      expect(queueCount(raw)).toBe(1);
      expect(mockNotifyFailedSend).not.toHaveBeenCalled();

      raw.exec('DROP TRIGGER pause_automatic_retry_during_retirement');
      resumeRealtimeDeliveries();
      const freshAccount = captureRealtimeDeliveryLease();
      let noticeRanInsideTransaction = true;
      mockNotifyFailedSend.mockImplementationOnce(async () => {
        noticeRanInsideTransaction = raw.inTransaction;
      });

      await expect(
        resendOutgoingRow(db, noRequestHttp, noAttachmentIo, row, () => 2_000_000, freshAccount),
      ).resolves.toBe('unsendable');

      expect(attemptsOf(raw, tempGuid)).toBe(OUTGOING_MAX_ATTEMPTS);
      expect(stateOf(raw, tempGuid)).toBe('error');
      expect(errorOf(raw, tempGuid)).toBe(1);
      expect(queueCount(raw)).toBe(1);
      expect(noticeRanInsideTransaction).toBe(false);
      expect(mockNotifyFailedSend).toHaveBeenCalledWith(db, 'c1', tempGuid, expect.any(Function));
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS pause_automatic_retry_during_retirement');
      if (drain) await drain;
      resumeRealtimeDeliveries();
      mockNotifyFailedSend.mockImplementation(async () => undefined);
      warn.mockRestore();
    }
  });

  it('rolls back real SQLite writes when revocation lands mid-transaction', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await strandedText(db, raw, 'c1', 'temp-guard-rollback', 1_000);
    const row = await retryableRow(db, 2_000_000);
    let checks = 0;
    const lease: RealtimeDeliveryLease = {
      generation: 7,
      // Checks 1-4 admit the outcome; 5-6 permit lock acquisition + BEGIN. Check 7 is the final
      // pre-COMMIT guard, after the repository updated the guid and deleted the queue row.
      isCurrent: () => {
        checks += 1;
        return checks < 7;
      },
    };

    await expect(
      resendOutgoingRow(db, okHttp(2_000_000), noAttachmentIo, row, () => 2_000_000, lease),
    ).resolves.toBe('paused');

    expect(checks).toBe(7);
    expect(stateOf(raw, 'temp-guard-rollback')).toBe('sending');
    expect(stateOf(raw, 'real-1')).toBeUndefined();
    expect(queueCount(raw)).toBe(1);
  });
});

describe('applyServerSendError', () => {
  it('bumps attempts + backoff when the guid still owns a queue row (fast async bridge failure)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await strandedText(db, raw, 'c1', 'temp-async', 1000);

    await applyServerSendError(db, 'temp-async', 502, 5_000_000);
    expect(stateOf(raw, 'temp-async')).toBe('error');
    expect(attemptsOf(raw, 'temp-async')).toBe(1);
    // Rescheduled with the ladder's backoff, not left at its insert-time value.
    const next = (
      raw
        .prepare("SELECT next_retry_at n FROM outgoing_queue WHERE temp_guid='temp-async'")
        .get() as {
        n: number;
      }
    ).n;
    expect(next).toBe(5_000_000 + outgoingBackoffMs(1));
  });

  it('only flips the bubble when no queue row exists (post-ack / real-guid failure)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await strandedText(db, raw, 'c1', 'temp-done', 1000);
    raw.prepare("DELETE FROM outgoing_queue WHERE temp_guid='temp-done'").run();

    await applyServerSendError(db, 'temp-done', 22, 5_000_000);
    expect(stateOf(raw, 'temp-done')).toBe('error');
    expect(queueCount(raw)).toBe(0); // nothing re-created, nothing to retry automatically
  });

  it('RETRYABLE post-ack failure re-enqueues an attachment ladder, and the drain re-uploads it', async () => {
    // The RCS immediate-ack flow: ack consumed the queue row and marked the bubble sent; the
    // background relay then failed and the server pushed message-send-error {retryable:true}
    // (send-phase — nothing reached Google). The ladder must re-arm automatically.
    const { db, raw } = await createTestDb();
    await seedChat(db, RCS_ATTACHMENT_CHAT_GUID);
    const chatId = await getChatIdByGuid(db, RCS_ATTACHMENT_CHAT_GUID);
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-async-pic',
      attachmentGuid: 'temp-async-pic-att',
      chatId: chatId!,
      chatGuid: RCS_ATTACHMENT_CHAT_GUID,
      localPath: 'file:///async.jpg',
      mimeType: 'image/jpeg',
      transferName: 'async.jpg',
      totalBytes: 9,
      now: 1000,
    });
    // Simulate the ack: bubble 'sent', queue row consumed.
    raw.prepare("UPDATE messages SET send_state='sent' WHERE guid='temp-async-pic'").run();
    raw.prepare("DELETE FROM outgoing_queue WHERE temp_guid='temp-async-pic'").run();

    await applyServerSendError(db, 'temp-async-pic', 502, 5_000_000, true);
    expect(stateOf(raw, 'temp-async-pic')).toBe('error'); // failure surfaced on the bubble
    const row = raw
      .prepare(
        "SELECT kind, attempts, payload FROM outgoing_queue WHERE temp_guid='temp-async-pic'",
      )
      .get() as { kind: string; attempts: number; payload: string };
    expect(row.kind).toBe('attachment');
    expect(row.attempts).toBe(1); // the failed relay WAS attempt one; also skips the grace window
    expect(JSON.parse(row.payload)).toEqual({
      attachmentGuid: 'temp-async-pic-att',
      localPath: 'file:///async.jpg',
    });

    // The drain then re-uploads from disk and the RCS echo ack reconciles it to 'sent'.
    const up = fakeIo({ upload: async (args) => ({ guid: args.tempGuid, viaPrivateApi: false }) });
    const res = await runOutgoingQueue(
      db,
      noRequestHttp,
      up.io,
      5_000_000 + 31_000,
      undefined,
      undefined,
      undefined,
      undefined,
      rcsAvailable,
    );
    expect(res.sent).toBe(1);
    expect(up.captured?.uri).toBe('file:///async.jpg');
    expect(stateOf(raw, 'temp-async-pic')).toBe('sent');
    expect(queueCount(raw)).toBe(0);
  });

  it('does not rebuild a queue-less CONTACT as its placeholder text', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const chatId = await getChatIdByGuid(db, 'c1');
    await insertOutgoingContact(db, {
      tempGuid: 'temp-async-contact',
      chatId: chatId!,
      chatGuid: 'c1',
      text: 'Ada Lovelace',
      contact: { firstName: 'Ada', lastName: 'Lovelace' },
      now: 1000,
    });
    raw.prepare("UPDATE messages SET send_state='sent' WHERE guid='temp-async-contact'").run();
    raw.prepare("DELETE FROM outgoing_queue WHERE temp_guid='temp-async-contact'").run();

    await applyServerSendError(db, 'temp-async-contact', 503, 5_000_000, true);
    expect(queueCount(raw)).toBe(0);
    expect(stateOf(raw, 'temp-async-contact')).toBe('error');
  });

  it('the re-enqueue CYCLE CAP stops a permanently-failing ack/fail loop after 2 automatic ladders', async () => {
    // ack → async-fail → re-enqueue resets everything durable, so a permanent failure would
    // loop forever without the in-memory cycle cap: 2 automatic ladders, then manual-only.
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const chatId = await getChatIdByGuid(db, 'c1');
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-loop',
      attachmentGuid: 'temp-loop-att',
      chatId: chatId!,
      chatGuid: 'c1',
      localPath: 'file:///never-sends.jpg',
      mimeType: 'image/jpeg',
      transferName: 'never-sends.jpg',
      totalBytes: 10,
      now: 1000,
    });
    const simulateAck = (): void => {
      raw.prepare("UPDATE messages SET send_state='sent', error=0 WHERE guid='temp-loop'").run();
      raw.prepare("DELETE FROM outgoing_queue WHERE temp_guid='temp-loop'").run();
    };
    simulateAck();
    await applyServerSendError(db, 'temp-loop', 502, 5_000_000, true);
    expect(queueCount(raw)).toBe(1); // cycle 1 granted
    simulateAck();
    await applyServerSendError(db, 'temp-loop', 502, 6_000_000, true);
    expect(queueCount(raw)).toBe(1); // cycle 2 granted
    simulateAck();
    await applyServerSendError(db, 'temp-loop', 502, 7_000_000, true);
    expect(queueCount(raw)).toBe(0); // cap spent: bubble-only; queue-less manual retry is unavailable
    expect(stateOf(raw, 'temp-loop')).toBe('error');

    // The cap belongs to one account generation. A late, rolled-back old-account event may still
    // consume its in-memory counter, but it must not penalize a later account that happens to reuse
    // the same temp guid.
    await applyServerSendError(db, 'temp-loop', 502, 8_000_000, true, 'next-account');
    expect(queueCount(raw)).toBe(1);
  });

  it('never re-enqueues a REACTION row (reactions are not flagged retryable by the server)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const chatId = await getChatIdByGuid(db, 'c1');
    await insertOutgoingReaction(db, {
      tempGuid: 'temp-react',
      chatId: chatId!,
      chatGuid: 'c1',
      targetGuid: 'mt-1',
      reaction: 'love',
      now: 1000,
    });
    raw.prepare("DELETE FROM outgoing_queue WHERE temp_guid='temp-react'").run();

    await applyServerSendError(db, 'temp-react', 502, 5_000_000, true);
    expect(queueCount(raw)).toBe(0);
    expect(stateOf(raw, 'temp-react')).toBe('error');
  });
});

/**
 * The drain and the "Try Again" button run on the same rows, from the same screen, on one shared
 * connection — the chat ticker drains every 20 s while the failed-message sheet is open.
 *
 * The dangerous outcome is not one of them losing: it is BOTH winning. The button re-sends under a
 * BRAND-NEW temp guid, and the temp id is exactly the key the server's idempotency cache is built
 * on — so a drain that POSTs the old row after the button already claimed it delivers the message
 * twice. Whoever gets there first must therefore leave the other with nothing to do.
 */
describe('runOutgoingQueue vs "Try Again" on the same row', () => {
  it('never lets both the drain and the manual claim act on one send', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const now = 10_000_000;
    await strandedText(db, raw, 'c1', 'temp-race', now - 200_000);
    raw.prepare("UPDATE messages SET send_state='error', error=502 WHERE guid='temp-race'").run();
    raw
      .prepare("UPDATE outgoing_queue SET attempts=1, next_retry_at=0 WHERE temp_guid='temp-race'")
      .run();

    let posts = 0;
    const countingHttp = fakeHttp(async () => {
      posts += 1;
      return { guid: 'real-race', dateCreated: now, dateDelivered: null };
    });

    // Both started in the SAME tick, neither awaited first — the real interleave.
    const drain = runOutgoingQueue(db, countingHttp, noAttachmentIo, now);
    const claim = claimFailedOutgoingForRetry(db, 'temp-race');
    const [res, handover] = await Promise.all([drain, claim]);

    if (handover.claim === 'claimed') {
      // The button owns the send: the row is leased and flipped to 'sending' under its ORIGINAL
      // temp guid, so the drain found nothing eligible and POSTed nothing. (Exactly one
      // idempotency key exists at the server for this message, whichever side wins.)
      expect(posts).toBe(0);
      expect(res.sent).toBe(0);
      expect(handover.row?.tempGuid).toBe('temp-race');
      expect(stateOf(raw, 'temp-race')).toBe('sending');
    } else {
      // The drain owns it: the claim was refused, and refusing must NOT have stripped the ladder
      // out from under the attempt that is running.
      expect(handover.claim).toBe('sending');
      expect(posts).toBe(1);
      expect(stateOf(raw, 'real-race')).toBe('sent');
    }
  });

  it('flips the bubble to sending as part of the lease, so a claim mid-POST is refused', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const now = 10_000_000;
    await strandedText(db, raw, 'c1', 'temp-mid', now - 200_000);
    raw.prepare("UPDATE messages SET send_state='error', error=502 WHERE guid='temp-mid'").run();
    raw
      .prepare("UPDATE outgoing_queue SET attempts=1, next_retry_at=0 WHERE temp_guid='temp-mid'")
      .run();

    // The user taps "Try Again" while this attempt's POST is in flight.
    let verdict: string | undefined;
    const tapDuringPost = fakeHttp(async () => {
      verdict = (await claimFailedOutgoingForRetry(db, 'temp-mid')).claim;
      return { guid: 'real-mid', dateCreated: now, dateDelivered: null };
    });

    const res = await runOutgoingQueue(db, tapDuringPost, noAttachmentIo, now);

    expect(verdict).toBe('sending'); // 'error' would have let the tap re-POST a live attempt
    expect(res.sent).toBe(1);
    expect(stateOf(raw, 'real-mid')).toBe('sent'); // the attempt reconciled normally
    expect(queueCount(raw)).toBe(0);
  });
});
