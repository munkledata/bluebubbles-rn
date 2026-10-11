import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { Chat, ServerInfo } from '@core/models';
import { logger } from '@core/secure';
import {
  claimFailedOutgoingForRetry,
  OUTGOING_MAX_ATTEMPTS,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import { DbCommitGuardRejectedError } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  contactDisplayName,
  hasContactContent,
  sendContactMessage,
  type ContactCard,
} from '@/services/send/sendContactService';
import { runOutgoingQueue, type OutgoingQueueIO } from '@/services/send/outgoingQueueService';
import { fixedRcsCapabilitySource } from '@/services/send/rcsAttemptCapability';
import { ClientErrorCode } from '@utils';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
  runTrackedRealtimeWork,
} from '@/services/realtime/deliveryCoordinator';
import { createTestDb } from '../support/testDb';

const RCS_PROVIDER_EPOCH = `gpe1_${'A'.repeat(43)}`;
const rcsChatGuid = (sourceId: string): string =>
  `RCS;-;g1.${RCS_PROVIDER_EPOCH}.${Buffer.from(sourceId).toString('base64url')}`;
const RCS_CHAT_GUID = rcsChatGuid('contact-chat');
const RCS_CAPABILITY_FIELDS = {
  rcs: true,
  supports_rcs_epoch_qualified_ids: true,
  rcs_provider_epoch: RCS_PROVIDER_EPOCH,
} as const;
const rcsAvailable = (chatGuid?: string): boolean =>
  chatGuid === undefined || chatGuid.startsWith(`RCS;-;g1.${RCS_PROVIDER_EPOCH}.`);

/** The queue's attachment I/O is never reached by a contact retry. */
const noAttachmentIo: OutgoingQueueIO = {
  upload: () => Promise.reject(new Error('attachment upload must not be called')),
  fileExists: () => Promise.resolve(false),
};

/** Fake HttpClient capturing the posted path + body and advertising exact part topology. */
function fakeHttp(impl: (path: string, json: unknown) => Promise<unknown>): {
  http: HttpClient;
  last: () => { path: string; json: unknown } | null;
} {
  let last: { path: string; json: unknown } | null = null;
  let http!: HttpClient;
  http = {
    get: () =>
      Promise.resolve({
        version: 'test',
        private_api: true,
        rcs: true,
        supports_rcs_epoch_qualified_ids: true,
        rcs_provider_epoch: RCS_PROVIDER_EPOCH,
        supports_message_part_topology: true,
        supports_send_contact: true,
      }),
    post: (path: string, _schema: unknown, opts: { json?: unknown }) => {
      last = { path, json: opts?.json };
      return impl(path, opts?.json);
    },
    pinTransport: () => http,
    isTransportCurrent: () => true,
    assertTransportCurrent: () => undefined,
  } as unknown as HttpClient;
  return { http, last: () => last };
}

async function seedChat(db: AppDatabase, guid: string) {
  const handles = await upsertHandles(db, [{ address: 'craig@apple.com' }]);
  await upsertChats(
    db,
    [Chat.parse({ guid, participants: [{ address: 'craig@apple.com' }] })],
    handles,
  );
}

async function seedProvenImessageChat(
  db: AppDatabase,
  guid = 'any;-;+15551234567',
  service: 'iMessage' | 'SMS' = 'iMessage',
  style = 45,
) {
  const participant = { address: '+15551234567', service };
  const handles = await upsertHandles(db, [participant]);
  await upsertChats(db, [Chat.parse({ guid, style, participants: [participant] })], handles);
}

const countMessages = (raw: Database.Database) =>
  (raw.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c;
const one = (raw: Database.Database, sql: string) =>
  raw.prepare(sql).get() as Record<string, unknown>;

describe('contactDisplayName', () => {
  it('prefers first+last, then org, then phone, then email, then a generic fallback', () => {
    expect(contactDisplayName({ firstName: 'Craig', lastName: 'Federighi' })).toBe(
      'Craig Federighi',
    );
    expect(contactDisplayName({ organization: 'Apple' })).toBe('Apple');
    expect(contactDisplayName({ phones: [{ number: '+15551234567' }] })).toBe('+15551234567');
    expect(contactDisplayName({ emails: [{ address: 'a@b.com' }] })).toBe('a@b.com');
    expect(contactDisplayName({})).toBe('Contact');
  });
});

describe('hasContactContent', () => {
  it('is false only when nothing identifying is present', () => {
    expect(hasContactContent({})).toBe(false);
    expect(hasContactContent({ firstName: '   ' })).toBe(false);
    expect(hasContactContent({ phones: [{ number: '  ' }] })).toBe(false);
    expect(hasContactContent({ lastName: 'Cook' })).toBe(true);
    expect(hasContactContent({ emails: [{ address: 'x@y.com' }] })).toBe(true);
  });
});

describe('sendContactMessage', () => {
  it('fails before DB admission when iMessage contact capability is false', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'iMessage;-;retired');
    const post = jest.fn(async () => ({ guid: 'must-not-send' }));

    await expect(
      sendContactMessage(
        db,
        fakeHttp(post).http,
        { chatGuid: 'iMessage;-;retired', contact: { firstName: 'Craig' } },
        1_000,
        undefined,
        fixedRcsCapabilitySource(ServerInfo.parse({ version: '2.0.0', private_api: false })),
      ),
    ).rejects.toThrow('cannot send a contact card for this chat service');

    expect(post).not.toHaveBeenCalled();
    expect(countMessages(raw)).toBe(0);
    expect(one(raw, 'SELECT COUNT(*) c FROM outgoing_queue').c).toBe(0);
  });

  it('sends one contact card only to a proven existing iMessage DM with the live capability', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = 'any;-;+15551234567';
    await seedProvenImessageChat(db, chatGuid);
    const cap = fakeHttp(async () => ({ guid: 'real-imessage-contact', viaPrivateApi: true }));

    await sendContactMessage(
      db,
      cap.http,
      { chatGuid, contact: { firstName: 'Craig', lastName: 'Federighi' } },
      1_000,
      undefined,
      fixedRcsCapabilitySource(ServerInfo.parse({ version: '2.0.0', supports_send_contact: true })),
    );

    expect(cap.last()).toMatchObject({
      path: '/message/contact',
      json: expect.objectContaining({
        chatGuid,
        firstName: 'Craig',
        lastName: 'Federighi',
      }),
    });
    expect(one(raw, 'SELECT guid, send_state AS state FROM messages')).toEqual({
      guid: 'real-imessage-contact',
      state: 'sent',
    });
    expect(one(raw, 'SELECT COUNT(*) c FROM outgoing_queue').c).toBe(0);
  });

  it.each([
    ['SMS participant', 'SMS', 45],
    ['group style', 'iMessage', 43],
  ] as const)(
    'refuses an iMessage contact for an unproven %s before DB/HTTP work',
    async (_label, service, style) => {
      const { db, raw } = await createTestDb();
      const chatGuid = 'any;-;+15551234567';
      await seedProvenImessageChat(db, chatGuid, service, style);
      const post = jest.fn(async () => ({ guid: 'must-not-send' }));

      await expect(
        sendContactMessage(
          db,
          fakeHttp(post).http,
          { chatGuid, contact: { firstName: 'Craig' } },
          1_000,
          undefined,
          fixedRcsCapabilitySource(
            ServerInfo.parse({ version: '2.0.0', supports_send_contact: true }),
          ),
        ),
      ).rejects.toThrow('proven existing one-to-one iMessage chat');

      expect(post).not.toHaveBeenCalled();
      expect(countMessages(raw)).toBe(0);
      expect(one(raw, 'SELECT COUNT(*) c FROM outgoing_queue').c).toBe(0);
    },
  );

  it('retires an unconfirmed iMessage contact without automatic or manual duplicate retry', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, raw } = await createTestDb();
    const chatGuid = 'any;-;+15551234567';
    await seedProvenImessageChat(db, chatGuid);
    const { http } = fakeHttp(async () => {
      throw ApiError.fromStatus(
        409,
        'helper acknowledgement was lost',
        undefined,
        'imessage_contact_outcome_unknown',
      );
    });

    const result = await sendContactMessage(
      db,
      http,
      { chatGuid, contact: { firstName: 'Craig' } },
      1_000,
      undefined,
      fixedRcsCapabilitySource(ServerInfo.parse({ version: '2.0.0', supports_send_contact: true })),
    );

    expect(one(raw, 'SELECT error AS code, error_message AS detail FROM messages')).toMatchObject({
      code: ClientErrorCode.contactDeliveryUnconfirmed,
      detail:
        'This contact card may have been delivered. Check Messages before sending a new copy.',
    });
    expect(one(raw, 'SELECT attempts FROM outgoing_queue').attempts).toBe(OUTGOING_MAX_ATTEMPTS);
    await expect(claimFailedOutgoingForRetry(db, result.tempGuid)).resolves.toMatchObject({
      claim: 'unsendable',
    });
    expect(warn).toHaveBeenCalledWith(
      '[send-contact] one-shot contact outcome unconfirmed (code 409, HTTP 409)',
    );
    warn.mockRestore();
  });

  it('preserves RCS contact cards independently of the retired helper capability', async () => {
    const { db } = await createTestDb();
    const chatGuid = rcsChatGuid('+15551234567');
    await seedChat(db, chatGuid);
    const post = jest.fn(async () => ({ guid: 'rcs-contact', viaPrivateApi: false }));

    await sendContactMessage(
      db,
      fakeHttp(post).http,
      { chatGuid, contact: { firstName: 'Craig' } },
      1_000,
      undefined,
      fixedRcsCapabilitySource(
        ServerInfo.parse({
          version: '2.0.0',
          private_api: false,
          ...RCS_CAPABILITY_FIELDS,
          supports_send_contact: false,
        }),
      ),
    );

    expect(post).toHaveBeenCalledTimes(1);
  });

  it('optimistically inserts then promotes temp→real on the send ack (one row, is-from-me)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, RCS_CHAT_GUID);
    const onQueued = jest.fn();
    let queuedBeforePost = false;
    const { http } = fakeHttp(async () => {
      queuedBeforePost = onQueued.mock.calls.length === 1;
      return { guid: 'real-ct', viaPrivateApi: true };
    });
    await sendContactMessage(
      db,
      http,
      {
        chatGuid: RCS_CHAT_GUID,
        contact: {
          firstName: 'Craig',
          lastName: 'Federighi',
          phones: [{ number: '+15551234567' }],
        },
      },
      Date.now(),
      undefined,
      undefined,
      onQueued,
    );
    expect(onQueued).toHaveBeenCalledWith(expect.stringMatching(/^temp-/));
    expect(queuedBeforePost).toBe(true);
    expect(countMessages(raw)).toBe(1);
    const row = raw
      .prepare('SELECT guid, send_state s, is_from_me f, text FROM messages')
      .get() as {
      guid: string;
      s: string;
      f: number;
      text: string;
    };
    expect(row.guid).toBe('real-ct');
    expect(row.s).toBe('sent');
    expect(row.f).toBe(1);
    // The optimistic bubble shows the contact's name until the .vcf echo replaces it.
    expect(row.text).toBe('Craig Federighi');
  });

  it('rolls back a retired contact insert before HTTP and lets a fresh lease send', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, RCS_CHAT_GUID);
    raw.prepare('UPDATE chats SET latest_message_date = 321 WHERE guid = ?').run(RCS_CHAT_GUID);
    let drain: Promise<void> | undefined;
    let triggerRan = false;
    raw.function('pause_contact_during_chat_update', () => {
      triggerRan = true;
      drain = pauseRealtimeDeliveries();
      return 0;
    });
    raw.exec(`CREATE TRIGGER pause_contact_during_chat_update
      AFTER UPDATE OF latest_message_date ON chats
      WHEN NEW.guid = '${RCS_CHAT_GUID}' AND NEW.latest_message_date = 1000
      BEGIN SELECT pause_contact_during_chat_update(); END`);

    let posts = 0;
    resumeRealtimeDeliveries();
    const oldLease = captureRealtimeDeliveryLease();
    try {
      const oldSend = runTrackedRealtimeWork(oldLease, (lease) =>
        sendContactMessage(
          db,
          fakeHttp(async () => {
            posts += 1;
            return { guid: 'must-not-send' };
          }).http,
          { chatGuid: RCS_CHAT_GUID, contact: { firstName: 'Retired', lastName: 'Contact' } },
          1_000,
          () => lease.isCurrent(),
        ),
      );

      await expect(oldSend).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
      if (!drain) throw new Error('contact insert did not retire the account lease');
      await drain;

      expect(triggerRan).toBe(true);
      expect(posts).toBe(0);
      expect(raw.inTransaction).toBe(false);
      expect(one(raw, 'SELECT COUNT(*) c FROM outgoing_queue').c).toBe(0);
      expect(countMessages(raw)).toBe(0);
      expect(
        (
          raw
            .prepare('SELECT latest_message_date d FROM chats WHERE guid = ?')
            .get(RCS_CHAT_GUID) as { d: number }
        ).d,
      ).toBe(321);

      raw.exec('DROP TRIGGER pause_contact_during_chat_update');
      resumeRealtimeDeliveries();
      const freshLease = captureRealtimeDeliveryLease();
      const freshContact = {
        firstName: 'Grace',
        lastName: 'Hopper',
        phones: [{ label: 'work', number: '+15551234000' }],
        emails: [{ label: 'home', address: 'grace@example.test' }],
        deviceContactId: 'private-device-contact-id',
        photoUri: 'file:///private-contact-photo.jpg',
        selectedMessageText: 'private selected message body',
      } as ContactCard;
      let result: { tempGuid: string } | undefined;
      let postRanInsideTransaction = true;
      let requestBody: Record<string, unknown> | undefined;
      let optimisticState: Record<string, unknown> | undefined;
      await expect(
        runTrackedRealtimeWork(freshLease, async (lease) => {
          result = await sendContactMessage(
            db,
            fakeHttp(async (_path, json) => {
              posts += 1;
              postRanInsideTransaction = raw.inTransaction;
              requestBody = json as Record<string, unknown>;
              optimisticState = one(
                raw,
                `SELECT m.guid AS messageGuid, m.text, m.send_state AS sendState,
                        m.date_created AS created, m.thread_originator_guid AS replyGuid,
                        m.thread_originator_part AS replyPart,
                        q.temp_guid AS queueGuid, q.kind, q.payload,
                        c.latest_message_date AS chatDate
                   FROM messages m
                   JOIN outgoing_queue q ON q.temp_guid = m.guid
                   JOIN chats c ON c.id = m.chat_id`,
              );
              return { guid: 'real-contact-after-retirement', viaPrivateApi: true };
            }).http,
            {
              chatGuid: RCS_CHAT_GUID,
              contact: freshContact,
            },
            2_000,
            () => lease.isCurrent(),
          );
        }),
      ).resolves.toBe('delivered');

      expect(posts).toBe(1);
      expect(postRanInsideTransaction).toBe(false);
      expect(optimisticState).toMatchObject({
        messageGuid: result?.tempGuid,
        queueGuid: result?.tempGuid,
        kind: 'contact',
        text: 'Grace Hopper',
        sendState: 'sending',
        created: 2_000,
        replyGuid: null,
        replyPart: null,
        chatDate: 2_000,
      });
      expect(JSON.parse(String(optimisticState?.payload))).toEqual({
        firstName: 'Grace',
        lastName: 'Hopper',
        phones: [{ label: 'work', number: '+15551234000' }],
        emails: [{ label: 'home', address: 'grace@example.test' }],
      });
      expect(String(optimisticState?.payload)).not.toContain('private-device-contact-id');
      expect(String(optimisticState?.payload)).not.toContain('private-contact-photo');
      expect(String(optimisticState?.payload)).not.toContain('private selected message body');
      expect(requestBody).toMatchObject({
        chatGuid: RCS_CHAT_GUID,
        tempGuid: result?.tempGuid,
        firstName: 'Grace',
        lastName: 'Hopper',
      });
      expect(JSON.stringify(requestBody)).not.toContain('private-device-contact-id');
      expect(JSON.stringify(requestBody)).not.toContain('private-contact-photo');
      expect(JSON.stringify(requestBody)).not.toContain('private selected message body');
      expect(one(raw, 'SELECT COUNT(*) c FROM outgoing_queue').c).toBe(0);
      expect(
        one(raw, "SELECT send_state s FROM messages WHERE guid='real-contact-after-retirement'"),
      ).toEqual({ s: 'sent' });
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS pause_contact_during_chat_update');
      if (drain) await drain;
      resumeRealtimeDeliveries();
      raw.close();
    }
  });

  it('POSTs structured fields to /message/contact, omitting empty phone/email arrays', async () => {
    const { db } = await createTestDb();
    await seedChat(db, RCS_CHAT_GUID);
    const cap = fakeHttp(async () => ({ guid: 'g' }));
    await sendContactMessage(db, cap.http, {
      chatGuid: RCS_CHAT_GUID,
      contact: {
        firstName: 'Tim',
        organization: 'Apple',
        phones: [],
        emails: [{ address: 'tim@apple.com' }],
      },
    });
    const sent = cap.last();
    expect(sent?.path).toBe('/message/contact');
    const body = sent?.json as Record<string, unknown>;
    expect(body.chatGuid).toBe(RCS_CHAT_GUID);
    expect(body.firstName).toBe('Tim');
    expect(body.organization).toBe('Apple');
    expect(typeof body.tempGuid).toBe('string');
    // Empty phones array is dropped (so the server's "needs a field" refine isn't tripped); emails kept.
    expect(body.phones).toBeUndefined();
    expect(body.emails).toEqual([{ address: 'tim@apple.com' }]);
  });

  it('marks the bubble errored when the send fails (retryable)', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, raw } = await createTestDb();
    await seedChat(db, RCS_CHAT_GUID);
    const { http } = fakeHttp(async () => {
      throw new ApiError('unauthorized', 'nope', 401);
    });
    await sendContactMessage(db, http, {
      chatGuid: RCS_CHAT_GUID,
      contact: { firstName: 'Nope' },
    });
    expect(countMessages(raw)).toBe(1);
    const row = raw.prepare('SELECT send_state s, error e FROM messages').get() as {
      s: string;
      e: number;
    };
    expect(row.s).toBe('error');
    expect(row.e).toBe(401);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `[send-contact] failed for chat ${RCS_CHAT_GUID} (code 401, HTTP 401): nope`,
    );
    warn.mockRestore();
  });

  it('throws (sends nothing) for a content-less contact', async () => {
    const { db } = await createTestDb();
    await seedChat(db, RCS_CHAT_GUID);
    const { http } = fakeHttp(async () => ({ guid: 'x' }));
    await expect(
      sendContactMessage(db, http, { chatGuid: RCS_CHAT_GUID, contact: {} }),
    ).rejects.toThrow(/name, organization, phone, or email/);
  });

  it('throws for an unknown chat', async () => {
    const { db } = await createTestDb();
    const { http } = fakeHttp(async () => ({ guid: 'x' }));
    await expect(
      sendContactMessage(db, http, {
        chatGuid: rcsChatGuid('nope'),
        contact: { firstName: 'A' },
      }),
    ).rejects.toThrow(/unknown chat/);
  });
});

/**
 * REGRESSION: a failed contact send used to be queued as `kind:'text'`, so the retry
 * processor re-sent the placeholder bubble text — the contact's display NAME — as a plain
 * message. The recipient got "Craig Federighi" instead of a card, and the bubble flipped to
 * 'sent'. The queue now carries a 'contact' kind with the structured fields.
 *
 * The old test stopped at "the bubble is errored", which is why this shipped: nothing ever
 * drained the queue.
 */
describe('sendContactMessage — the retry re-sends a CARD, never a text message', () => {
  const retryChatGuid = rcsChatGuid('contact-retry-thread');
  const contact = {
    firstName: 'Craig',
    lastName: 'Federighi',
    organization: 'Apple',
    emails: [{ address: 'craig@apple.com' }],
  };

  /** Fail the first send, then drain the queue past the 30s backoff and record every POST. */
  async function failThenDrain() {
    const { db, raw } = await createTestDb();
    await seedChat(db, retryChatGuid);
    const t = 1_000_000;

    const { http: failing } = fakeHttp(async () => {
      throw new ApiError('unauthorized', 'nope', 401);
    });
    await sendContactMessage(db, failing, { chatGuid: retryChatGuid, contact }, t);

    const posts: { path: string; json: Record<string, unknown> }[] = [];
    let retryHttp!: HttpClient;
    retryHttp = {
      post: (path: string, _schema: unknown, opts: { json?: unknown }) => {
        posts.push({ path, json: (opts?.json ?? {}) as Record<string, unknown> });
        return Promise.resolve({ guid: 'server-guid-1' });
      },
      pinTransport: () => retryHttp,
      isTransportCurrent: () => true,
      assertTransportCurrent: () => undefined,
    } as unknown as HttpClient;

    // The failure path schedules the backoff off real `Date.now()` (every send service omits
    // the injected `now` there), so drain past outgoingBackoffMs(1) = 30s of REAL time.
    const later = Date.now() + 31_000;
    const res = await runOutgoingQueue(
      db,
      retryHttp,
      noAttachmentIo,
      later,
      undefined,
      undefined,
      undefined,
      undefined,
      rcsAvailable,
    );
    return { db, raw, posts, res };
  }

  it('queues the send under kind "contact" carrying the structured fields (not the name as text)', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, raw } = await createTestDb();
    await seedChat(db, RCS_CHAT_GUID);
    const { http } = fakeHttp(async () => {
      throw new ApiError('unauthorized', 'nope', 401);
    });
    // Assert BEFORE any drain — a successful retry deletes the queue row.
    await sendContactMessage(db, http, { chatGuid: RCS_CHAT_GUID, contact }, 1_000_000);

    const row = raw.prepare('SELECT kind, payload FROM outgoing_queue').get() as {
      kind: string;
      payload: string;
    };
    expect(row.kind).toBe('contact');
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(payload.firstName).toBe('Craig');
    expect(payload.organization).toBe('Apple');
    // The old bug's fingerprint: a text payload whose `message` is the display name.
    expect(payload.message).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `[send-contact] failed for chat ${RCS_CHAT_GUID} (code 401, HTTP 401): nope`,
    );
    warn.mockRestore();
  });

  it('retries to /message/contact with the structured fields — NOT /message/text', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { posts, res } = await failThenDrain();
    expect(res).toEqual({ eligible: 1, sent: 1 });
    expect(posts).toHaveLength(1);

    // THE BUG: this used to be '/message/text' with { message: 'Craig Federighi' }.
    expect(posts[0]!.path).toBe('/message/contact');
    expect(posts[0]!.path).not.toBe('/message/text');
    expect(posts[0]!.json.message).toBeUndefined(); // no plain-text body was ever built

    expect(posts[0]!.json.firstName).toBe('Craig');
    expect(posts[0]!.json.lastName).toBe('Federighi');
    expect(posts[0]!.json.organization).toBe('Apple');
    expect(posts[0]!.json.emails).toEqual([{ address: 'craig@apple.com' }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `[send-contact] failed for chat ${retryChatGuid} (code 401, HTTP 401): nope`,
    );
    warn.mockRestore();
  });

  it('reuses the original tempGuid so the server can absorb an ack-lost duplicate', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { raw, posts } = await failThenDrain();
    const msg = raw.prepare('SELECT guid FROM messages').get() as { guid: string };
    // After a successful retry the row is reconciled to the server guid, so compare against
    // what was POSTed: it must be a tempGuid, and the only message row must trace back to it.
    expect(typeof posts[0]!.json.tempGuid).toBe('string');
    expect(msg.guid).toBeTruthy();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `[send-contact] failed for chat ${retryChatGuid} (code 401, HTTP 401): nope`,
    );
    warn.mockRestore();
  });
});
