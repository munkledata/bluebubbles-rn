import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import { UnsupportedIMessageTextError } from '@core/api/endpoints/messages';
import type { HttpClient, HttpTransportSnapshot } from '@core/api/http';
import { Chat, Message, ServerInfo } from '@core/models';
import { logger } from '@core/secure';
import {
  getScheduledById,
  OUTGOING_MAX_ATTEMPTS,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { DbCommitGuardRejectedError } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { useSessionStore } from '@state/sessionStore';
import {
  captureSessionRcsCapabilityLease,
  fixedRcsCapabilitySource,
} from '@/services/send/rcsAttemptCapability';
import { generateTempGuid, sendTextMessage } from '@/services/send/sendService';
import { createTestDb } from '../support/testDb';
import { claimScheduled, insertScheduled } from '../support/repositoryWrappers';

const RCS_PROVIDER_EPOCH = `gpe1_${'A'.repeat(43)}`;
const rcsChatGuid = (sourceId: string): string =>
  `RCS;-;g1.${RCS_PROVIDER_EPOCH}.${Buffer.from(sourceId).toString('base64url')}`;
const currentRcsInfo = (extra: Record<string, unknown> = {}): ServerInfo =>
  ServerInfo.parse({
    version: '2.0.0',
    rcs: true,
    supports_rcs_epoch_qualified_ids: true,
    rcs_provider_epoch: RCS_PROVIDER_EPOCH,
    ...extra,
  });

/** Minimal fake HttpClient: only `post` is used (by sendText). */
function fakeHttp(impl: (json: unknown) => Promise<unknown>): HttpClient {
  let http!: HttpClient;
  http = {
    post: (_path: string, _schema: unknown, opts: { json?: unknown }) => impl(opts?.json),
    pinTransport: () => http,
    isTransportCurrent: () => true,
    assertTransportCurrent: () => undefined,
  } as unknown as HttpClient;
  return http;
}

function revisionPinnedHttp(options: {
  get?: () => Promise<unknown>;
  post?: () => Promise<unknown>;
}): HttpClient {
  let root!: HttpClient;
  root = {
    pinTransport: () => {
      const { origin, transportRevision: revision } = useSessionStore.getState();
      const isTransportCurrent = (): boolean =>
        useSessionStore.getState().transportRevision === revision;
      let pinned!: HttpClient;
      pinned = {
        get: () => options.get?.() ?? Promise.reject(new Error('unexpected GET')),
        post: () => options.post?.() ?? Promise.reject(new Error('unexpected POST')),
        pinTransport: () => pinned,
        isTransportCurrent,
        snapshotTransport: () =>
          ({ origin: origin ?? '', transportRevision: revision }) as HttpTransportSnapshot,
        assertTransportCurrent: () => {
          if (!isTransportCurrent()) {
            throw new ApiError('cancelled', 'test transport changed');
          }
        },
      } as unknown as HttpClient;
      return pinned;
    },
    isTransportCurrent: () => true,
    assertTransportCurrent: () => undefined,
  } as unknown as HttpClient;
  return root;
}

async function seedChat(db: AppDatabase, guid: string) {
  const handles = await upsertHandles(db, [{ address: 'craig@apple.com' }]);
  await upsertChats(
    db,
    [Chat.parse({ guid, participants: [{ address: 'craig@apple.com' }] })],
    handles,
  );
}

async function seedProvenIMessageChat(db: AppDatabase, guid: string) {
  const participant = { address: '+15551234567', service: 'iMessage' as const };
  const handles = await upsertHandles(db, [participant]);
  await upsertChats(db, [Chat.parse({ guid, style: 45, participants: [participant] })], handles);
}

function countMessages(raw: Database.Database) {
  return (raw.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c;
}

describe('generateTempGuid', () => {
  it('returns temp- plus 16 hex characters from a cryptographic UUID (review M090)', () => {
    const draws = Array.from({ length: 1_000 }, () => generateTempGuid());
    for (const id of draws) expect(id).toMatch(/^temp-[0-9a-f]{16}$/);
    expect(new Set(draws).size).toBe(draws.length);
  });
});

describe('sendTextMessage', () => {
  it('discovers RCS attempt ownership on a fixed client with no foreground session', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = rcsChatGuid('cold-capability');
    await seedChat(db, chatGuid);
    const previousSession = useSessionStore.getState();
    useSessionStore.setState({
      status: 'loading',
      origin: null,
      password: null,
      serverInfo: null,
    });
    let discoveryFails = true;
    let postedGeneration: number | undefined;
    let postedMethod: string | undefined;
    let http!: HttpClient;
    http = {
      get: jest.fn(async (path: string) => {
        expect(path).toBe('/server/info');
        expect(countMessages(raw)).toBe(0);
        if (discoveryFails) throw new Error('server-info unavailable');
        return {
          private_api: true,
          rcs: true,
          supports_rcs_send_attempt_ownership: true,
          supports_rcs_epoch_qualified_ids: true,
          rcs_provider_epoch: RCS_PROVIDER_EPOCH,
        };
      }),
      post: jest.fn(async (_path: string, _schema: unknown, options: { json?: unknown }) => {
        const body = options.json as {
          tempGuid: string;
          clientAttemptGeneration?: number;
          method?: string;
        };
        postedGeneration = body.clientAttemptGeneration;
        postedMethod = body.method;
        return {
          guid: body.tempGuid,
          attemptGuid: 'server-attempt-1',
          clientAttemptGeneration: body.clientAttemptGeneration,
          dateCreated: 1_000,
          dateDelivered: null,
        };
      }),
      pinTransport: () => http,
      isTransportCurrent: () => true,
      assertTransportCurrent: () => undefined,
    } as unknown as HttpClient;

    try {
      await expect(
        sendTextMessage(db, http, { chatGuid, text: 'not inserted yet' }),
      ).rejects.toThrow('server-info unavailable');
      expect(countMessages(raw)).toBe(0);
      expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({
        count: 0,
      });

      discoveryFails = false;
      await sendTextMessage(db, http, { chatGuid, text: 'owned attempt' });
      expect(postedGeneration).toBe(1);
      expect(postedMethod).toBe('apple-script');
      expect(http.get).toHaveBeenCalledTimes(2);
      expect(useSessionStore.getState()).toMatchObject({ origin: null, serverInfo: null });
    } finally {
      useSessionStore.setState({
        status: previousSession.status,
        origin: previousSession.origin,
        password: previousSession.password,
        serverInfo: previousSession.serverInfo,
      });
    }
  });

  it('rejects RCS text before DB admission when the live RCS capability is off', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = rcsChatGuid('disabled-capability');
    await seedChat(db, chatGuid);
    const post = jest.fn(async () => ({ guid: 'must-not-send' }));

    await expect(
      sendTextMessage(
        db,
        fakeHttp(post),
        { chatGuid, text: 'do not queue' },
        1_000,
        undefined,
        undefined,
        undefined,
        fixedRcsCapabilitySource(ServerInfo.parse({ version: '2.0.0', rcs: false })),
      ),
    ).rejects.toThrow('unavailable or previous Google pairing');

    expect(post).not.toHaveBeenCalled();
    expect(countMessages(raw)).toBe(0);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({
      count: 0,
    });
  });

  it('does not admit an RCS row when the server origin rotates during capability discovery', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = rcsChatGuid('rotating-capability');
    await seedChat(db, chatGuid);
    const previousSession = useSessionStore.getState();
    const infoA = currentRcsInfo({
      supports_rcs_send_attempt_ownership: true,
    });
    const infoB = currentRcsInfo({
      supports_rcs_send_attempt_ownership: false,
    });
    useSessionStore.getState().connected('https://origin-a.test', 'password', infoA);
    useSessionStore.setState({ serverInfo: null });

    let releaseInfo!: (info: unknown) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const response = new Promise<unknown>((resolve) => {
      releaseInfo = resolve;
    });
    const capabilityGet = jest.fn(async () => {
      markStarted();
      return response;
    });
    const post = jest.fn(async () => ({ guid: 'must-not-send' }));
    const client = revisionPinnedHttp({ get: capabilityGet, post });

    try {
      const capabilityLease = captureSessionRcsCapabilityLease();
      if (!capabilityLease) throw new Error('expected a connected capability lease');
      const send = sendTextMessage(
        db,
        client,
        { chatGuid, text: 'stay on A' },
        undefined,
        undefined,
        undefined,
        undefined,
        capabilityLease,
      );
      await started;
      useSessionStore.getState().rotateOrigin('https://origin-b.test', infoB);
      releaseInfo(infoA);

      await expect(send).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
      expect(capabilityGet).toHaveBeenCalledTimes(1);
      expect(post).not.toHaveBeenCalled();
      expect(countMessages(raw)).toBe(0);
      expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({
        count: 0,
      });
      expect(useSessionStore.getState().serverInfo).toBe(infoB);
    } finally {
      useSessionStore.setState(previousSession);
    }
  });

  it('marks a durable row retryable instead of POSTing after a post-admission origin rotation', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const previousSession = useSessionStore.getState();
    const infoA = ServerInfo.parse({ version: '2.0.0', private_api: true });
    const infoB = ServerInfo.parse({ version: '2.0.0', private_api: false });
    useSessionStore.getState().connected('https://origin-a.test', 'password', infoA);
    const post = jest.fn(async () => ({ guid: 'must-not-send' }));
    const client = revisionPinnedHttp({ post });

    try {
      await expect(
        sendTextMessage(db, client, { chatGuid: 'c1', text: 'durable retry' }, 1_000, () => {
          useSessionStore.getState().rotateOrigin('https://origin-b.test', infoB);
        }),
      ).resolves.toMatchObject({ tempGuid: expect.stringMatching(/^temp-/) });

      expect(post).not.toHaveBeenCalled();
      expect(raw.prepare('SELECT send_state AS sendState FROM messages').get()).toEqual({
        sendState: 'error',
      });
      expect(raw.prepare('SELECT attempts FROM outgoing_queue').get()).toEqual({ attempts: 1 });
    } finally {
      useSessionStore.setState(previousSession);
      warn.mockRestore();
    }
  });

  it('leaves queued RCS text owned for retry when the same transport retires RCS', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, raw } = await createTestDb();
    const chatGuid = rcsChatGuid('same-transport-retirement');
    await seedChat(db, chatGuid);
    const previousSession = useSessionStore.getState();
    const info = currentRcsInfo();
    useSessionStore.getState().connected('https://origin-a.test', 'password', info);
    const post = jest.fn(async () => ({ guid: 'must-not-send' }));
    const client = revisionPinnedHttp({ post });

    try {
      const capabilityLease = captureSessionRcsCapabilityLease();
      if (!capabilityLease) throw new Error('expected a connected capability lease');
      await expect(
        sendTextMessage(
          db,
          client,
          { chatGuid, text: 'stay local' },
          1_000,
          () => {
            const state = useSessionStore.getState();
            state.setServerInfoForTransport(
              state.origin!,
              state.transportRevision,
              ServerInfo.parse({ version: '2.0.0', rcs: false }),
            );
          },
          undefined,
          undefined,
          capabilityLease,
        ),
      ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);

      expect(post).not.toHaveBeenCalled();
      expect(raw.prepare('SELECT send_state AS sendState FROM messages').get()).toEqual({
        sendState: 'sending',
      });
      expect(raw.prepare('SELECT attempts FROM outgoing_queue').get()).toEqual({ attempts: 0 });
    } finally {
      useSessionStore.setState(previousSession);
      warn.mockRestore();
    }
  });

  it('optimistically inserts then promotes temp→real on success (one row, queue cleared)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await sendTextMessage(
      db,
      fakeHttp(async () => ({ guid: 'real-1', dateCreated: 1000, dateDelivered: null })),
      { chatGuid: 'c1', text: 'hello' },
    );

    expect(countMessages(raw)).toBe(1);
    const row = raw.prepare('SELECT guid, send_state s, is_from_me f FROM messages').get() as {
      guid: string;
      s: string;
      f: number;
    };
    expect(row.guid).toBe('real-1');
    expect(row.s).toBe('sent');
    expect(row.f).toBe(1);
    expect((raw.prepare('SELECT COUNT(*) c FROM outgoing_queue').get() as { c: number }).c).toBe(0);
  });

  it('does not let an old server advertisement restore retired iMessage effects', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const request = jest.fn(async () => ({ guid: 'must-not-send' }));

    await expect(
      sendTextMessage(
        db,
        fakeHttp(request),
        { chatGuid: 'c1', text: 'party', effectId: 'com.apple.messages.effect.CKConfettiEffect' },
        undefined,
        undefined,
        undefined,
        undefined,
        fixedRcsCapabilitySource(ServerInfo.parse({ version: '2.0.0', private_api: true })),
      ),
    ).rejects.toThrow('Private API message features were retired in this release.');

    expect(request).not.toHaveBeenCalled();
    expect(countMessages(raw)).toBe(0);
    expect((raw.prepare('SELECT COUNT(*) c FROM outgoing_queue').get() as { c: number }).c).toBe(0);
  });

  it('does not duplicate when the socket echo lands FIRST (deletes temp)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    // The fake "server" upserts the real message (like DbEventSink) before responding.
    await sendTextMessage(
      db,
      fakeHttp(async () => {
        const handles = await upsertHandles(db, [{ address: 'craig@apple.com' }]);
        const map = new Map<string, number>();
        const chatId = (
          raw.prepare('SELECT id FROM chats WHERE guid=?').get('c1') as { id: number }
        ).id;
        map.set('craig@apple.com', handles.get('craig@apple.com')!);
        await upsertMessages(
          db,
          [Message.parse({ guid: 'real-2', text: 'hello', isFromMe: true, dateCreated: 1000 })],
          () => chatId,
          map,
        );
        return { guid: 'real-2', dateCreated: 1000, dateDelivered: 2000 };
      }),
      { chatGuid: 'c1', text: 'hello' },
    );

    expect(countMessages(raw)).toBe(1);
    expect((raw.prepare('SELECT guid FROM messages').get() as { guid: string }).guid).toBe(
      'real-2',
    );
  });

  it('does not duplicate when the echo arrives AFTER promotion (conflict update)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await sendTextMessage(
      db,
      fakeHttp(async () => ({ guid: 'real-3', dateCreated: 1000, dateDelivered: null })),
      {
        chatGuid: 'c1',
        text: 'hi',
      },
    );
    // Now the socket echo upserts the same real guid.
    const chatId = (raw.prepare('SELECT id FROM chats WHERE guid=?').get('c1') as { id: number })
      .id;
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'real-3',
          text: 'hi',
          isFromMe: true,
          dateCreated: 1000,
          dateDelivered: 5000,
        }),
      ],
      () => chatId,
      new Map(),
    );
    expect(countMessages(raw)).toBe(1);
  });

  it('promotes the narrow exact GUID before later history upsert, leaving one canonical bubble', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = 'any;-;+15551234567';
    const guid = '11111111-2222-4333-8444-555555555555';
    await seedProvenIMessageChat(db, chatGuid);
    const post = jest.fn(
      async (_path: string, _schema: unknown, options: { json?: Record<string, unknown> }) => ({
        guid,
        tempGuid: options.json?.tempGuid,
        viaPrivateApi: true,
      }),
    );
    let client!: HttpClient;
    client = {
      post,
      pinTransport: () => client,
      isTransportCurrent: () => true,
      assertTransportCurrent: () => undefined,
    } as unknown as HttpClient;

    await sendTextMessage(
      db,
      client,
      { chatGuid, text: 'exact identity' },
      1_000,
      undefined,
      undefined,
      undefined,
      fixedRcsCapabilitySource(
        ServerInfo.parse({ version: '2.0.0', supports_imessage_plain_text: true }),
      ),
    );

    expect(post).toHaveBeenCalledWith('/message/imessage-text', expect.anything(), {
      captureErrorDetail: true,
      retry: false,
      json: {
        chatGuid,
        message: 'exact identity',
        tempGuid: expect.stringMatching(/^temp-/),
      },
    });
    expect(raw.prepare('SELECT guid, send_state AS sendState FROM messages').get()).toEqual({
      guid,
      sendState: 'sent',
    });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 0 });

    const chatId = (
      raw.prepare('SELECT id FROM chats WHERE guid = ?').get(chatGuid) as { id: number }
    ).id;
    await upsertMessages(
      db,
      [Message.parse({ guid, text: 'exact identity', isFromMe: true, dateCreated: 1_000 })],
      () => chatId,
      new Map(),
    );
    expect(raw.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 });
    expect(raw.prepare('SELECT guid FROM messages').get()).toEqual({ guid });
  });

  it('refuses a text the narrow route cannot carry with a specific error, before saving anything', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = 'any;-;+15551234567';
    // U+FFFC is the placeholder Apple uses for an inline attachment; the narrow route refuses it.
    const text = 'see \ufffc attached';
    await seedProvenIMessageChat(db, chatGuid);
    const post = jest.fn();
    let client!: HttpClient;
    client = {
      post,
      pinTransport: () => client,
      isTransportCurrent: () => true,
      assertTransportCurrent: () => undefined,
    } as unknown as HttpClient;

    await expect(
      sendTextMessage(
        db,
        client,
        { chatGuid, text },
        1_000,
        undefined,
        undefined,
        undefined,
        fixedRcsCapabilitySource(
          ServerInfo.parse({ version: '2.0.0', supports_imessage_plain_text: true }),
        ),
      ),
    ).rejects.toBeInstanceOf(UnsupportedIMessageTextError);
    expect(post).not.toHaveBeenCalled();
    expect(countMessages(raw)).toBe(0);
  });

  it('arms one narrow retry only for the exact pre-dispatch unavailable response', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = 'iMessage;-;+15551234567';
    await seedProvenIMessageChat(db, chatGuid);
    const unavailable = ApiError.fromStatus(
      503,
      'helper unavailable',
      undefined,
      'imessage_plain_text_unavailable',
    );

    await sendTextMessage(
      db,
      fakeHttp(async () => {
        throw unavailable;
      }),
      { chatGuid, text: 'retry only this route' },
      1_000,
      undefined,
      undefined,
      undefined,
      fixedRcsCapabilitySource(
        ServerInfo.parse({ version: '2.0.0', supports_imessage_plain_text: true }),
      ),
    );

    const row = raw
      .prepare(
        `SELECT m.send_state AS sendState, q.attempts, q.payload
           FROM messages m JOIN outgoing_queue q ON q.temp_guid = m.guid`,
      )
      .get() as { sendState: string; attempts: number; payload: string };
    expect(row.sendState).toBe('error');
    expect(row.attempts).toBe(1);
    expect(JSON.parse(row.payload)).toMatchObject({
      message: 'retry only this route',
      imessagePlainTextV1: true,
      imessagePlainTextRetrySafeV1: true,
    });
  });

  it.each([
    ['no connection', new ApiError('no_connection', 'Network request failed')],
    ['a client timeout', new ApiError('timeout', 'Request timed out')],
    ['an untyped proxy 502 while the server restarts', ApiError.fromStatus(502, 'Bad Gateway')],
  ])('keeps an offline plain-text send queued for retry after %s', async (_label, failure) => {
    const { db, raw } = await createTestDb();
    const chatGuid = 'iMessage;-;+15551234567';
    await seedProvenIMessageChat(db, chatGuid);

    await sendTextMessage(
      db,
      fakeHttp(async () => {
        throw failure;
      }),
      { chatGuid, text: 'On my way' },
      1_000,
      undefined,
      undefined,
      undefined,
      fixedRcsCapabilitySource(
        ServerInfo.parse({ version: '2.0.0', supports_imessage_plain_text: true }),
      ),
    );

    // Not "may have been delivered": bbd's idempotency cache makes a same-tempGuid re-POST safe.
    const row = raw
      .prepare(
        `SELECT m.send_state AS sendState, q.attempts, q.payload
           FROM messages m JOIN outgoing_queue q ON q.temp_guid = m.guid`,
      )
      .get() as { sendState: string; attempts: number; payload: string };
    expect(row.sendState).toBe('error');
    expect(row.attempts).toBe(1);
    expect(JSON.parse(row.payload)).toMatchObject({
      message: 'On my way',
      imessagePlainTextV1: true,
      imessagePlainTextRetrySafeV1: true,
    });
  });

  it('still retires a plain-text send the server says may have been delivered', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = 'iMessage;-;+15551234567';
    await seedProvenIMessageChat(db, chatGuid);

    await sendTextMessage(
      db,
      fakeHttp(async () => {
        throw ApiError.fromStatus(409, 'unknown', undefined, 'imessage_plain_text_outcome_unknown');
      }),
      { chatGuid, text: 'maybe sent' },
      1_000,
      undefined,
      undefined,
      undefined,
      fixedRcsCapabilitySource(
        ServerInfo.parse({ version: '2.0.0', supports_imessage_plain_text: true }),
      ),
    );

    const row = raw.prepare('SELECT attempts, payload FROM outgoing_queue').get() as {
      attempts: number;
      payload: string;
    };
    expect(row.attempts).toBe(OUTGOING_MAX_ATTEMPTS);
    expect(JSON.parse(row.payload)).not.toHaveProperty('imessagePlainTextRetrySafeV1');
  });

  it('marks the message errored on failure (one row, queue attempt bumped)', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await sendTextMessage(
      db,
      fakeHttp(async () => {
        throw new ApiError('unauthorized', 'nope', 401);
      }),
      { chatGuid: 'c1', text: 'fails' },
    );
    expect(countMessages(raw)).toBe(1);
    const row = raw.prepare('SELECT send_state s, error e FROM messages').get() as {
      s: string;
      e: number;
    };
    expect(row.s).toBe('error');
    expect(row.e).toBe(401);
    expect(
      (raw.prepare('SELECT attempts FROM outgoing_queue').get() as { attempts: number }).attempts,
    ).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[send] failed for chat c1 (code 401, HTTP 401): nope');
    warn.mockRestore();
  });

  it('throws for an unknown chat', async () => {
    const { db } = await createTestDb();
    await expect(
      sendTextMessage(
        db,
        fakeHttp(async () => ({})),
        { chatGuid: 'nope', text: 'x' },
      ),
    ).rejects.toThrow(/unknown chat/);
  });

  it('rolls back ordinary construction when its account retires before commit, then allows a fresh send', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const beforeChat = raw
      .prepare('SELECT latest_message_date AS latestMessageDate FROM chats WHERE guid = ?')
      .get('c1');
    let current = true;
    let queued = 0;
    let posts = 0;

    raw.function('retire_ordinary_send_during_insert', () => {
      current = false;
      return 0;
    });
    raw.exec(`
      CREATE TRIGGER retire_ordinary_send_during_insert
      AFTER INSERT ON outgoing_queue
      BEGIN
        SELECT retire_ordinary_send_during_insert();
      END
    `);

    await expect(
      sendTextMessage(
        db,
        fakeHttp(async () => {
          posts += 1;
          return { guid: 'must-not-send', dateCreated: 1_000, dateDelivered: null };
        }),
        { chatGuid: 'c1', text: 'account A only' },
        1_000,
        () => {
          queued += 1;
        },
        undefined,
        () => current,
      ),
    ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);

    expect(posts).toBe(0);
    expect(queued).toBe(0);
    expect(raw.inTransaction).toBe(false);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
    expect(
      raw
        .prepare('SELECT latest_message_date AS latestMessageDate FROM chats WHERE guid = ?')
        .get('c1'),
    ).toEqual(beforeChat);

    raw.exec('DROP TRIGGER retire_ordinary_send_during_insert');
    current = true;
    await sendTextMessage(
      db,
      fakeHttp(async () => {
        expect(raw.inTransaction).toBe(false);
        posts += 1;
        return { guid: 'real-after-retry', dateCreated: 2_000, dateDelivered: null };
      }),
      { chatGuid: 'c1', text: 'fresh current send' },
      2_000,
      undefined,
      undefined,
      () => current,
    );

    expect(posts).toBe(1);
    expect(raw.prepare('SELECT guid, send_state AS sendState FROM messages').get()).toEqual({
      guid: 'real-after-retry',
      sendState: 'sent',
    });
  });

  it('does not POST an ordinary send when onQueued observes account retirement', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    let current = true;
    let posts = 0;

    const send = sendTextMessage(
      db,
      fakeHttp(async () => {
        posts += 1;
        return { guid: 'must-not-send', dateCreated: 1_000, dateDelivered: null };
      }),
      { chatGuid: 'c1', text: 'durable but retired' },
      1_000,
      () => {
        current = false;
      },
      undefined,
      () => current,
    );

    await expect(send).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    expect(posts).toBe(0);
    expect(raw.inTransaction).toBe(false);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 1 });
    expect(raw.prepare('SELECT send_state AS sendState FROM messages').get()).toEqual({
      sendState: 'sending',
    });
  });

  it('does not settle an ordinary send after its account retires during HTTP', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    let current = true;
    let releaseResponse!: (value: unknown) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const response = new Promise<unknown>((resolve) => {
      releaseResponse = resolve;
    });

    const send = sendTextMessage(
      db,
      fakeHttp(() => {
        expect(raw.inTransaction).toBe(false);
        markStarted();
        return response;
      }),
      { chatGuid: 'c1', text: 'A request already started' },
      1_000,
      undefined,
      undefined,
      () => current,
    );
    await started;
    current = false;
    releaseResponse({ guid: 'late-real-guid', dateCreated: 1_000, dateDelivered: null });

    await expect(send).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    expect(raw.inTransaction).toBe(false);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 1 });
    expect(raw.prepare('SELECT guid, send_state AS sendState FROM messages').get()).toMatchObject({
      guid: expect.stringMatching(/^temp-/),
      sendState: 'sending',
    });
  });

  it('does not POST when a scheduled account is revoked after handoff but before the request', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const scheduledId = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'account A only',
      scheduledFor: 1,
    });
    expect(await claimScheduled(db, scheduledId)).toBe(true);

    let current = true;
    let posts = 0;
    const send = sendTextMessage(
      db,
      fakeHttp(async () => {
        posts += 1;
        return { guid: 'must-not-send', dateCreated: 2, dateDelivered: null };
      }),
      { chatGuid: 'c1', text: 'account A only' },
      1,
      () => {
        // The atomic handoff has committed; model Disconnect landing in the precise continuation
        // before the service starts its HTTP request.
        current = false;
      },
      {
        scheduledId,
        transition: { kind: 'sent' },
        commitGuard: () => current,
      },
    );

    await expect(send).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    expect(posts).toBe(0);
    expect(await getScheduledById(db, scheduledId)).toMatchObject({ status: 'sent' });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 });
  });
});
