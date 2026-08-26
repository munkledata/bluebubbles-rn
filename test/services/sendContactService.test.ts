import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { Chat } from '@core/models';
import { logger } from '@core/secure';
import { upsertChats, upsertHandles } from '@db/repositories';
import { DbCommitGuardRejectedError } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  contactDisplayName,
  hasContactContent,
  sendContactMessage,
  type ContactCard,
} from '@/services/send/sendContactService';
import { runOutgoingQueue, type OutgoingQueueIO } from '@/services/send/outgoingQueueService';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
  runTrackedRealtimeWork,
} from '@/services/realtime/deliveryCoordinator';
import { createTestDb } from '../support/testDb';

/** The queue's attachment I/O is never reached by a contact retry. */
const noAttachmentIo: OutgoingQueueIO = {
  upload: () => Promise.reject(new Error('attachment upload must not be called')),
  fileExists: () => Promise.resolve(false),
};

/** Fake HttpClient capturing the posted path + body (only `post` is used by sendContact). */
function fakeHttp(impl: (path: string, json: unknown) => Promise<unknown>): {
  http: HttpClient;
  last: () => { path: string; json: unknown } | null;
} {
  let last: { path: string; json: unknown } | null = null;
  const http = {
    post: (path: string, _schema: unknown, opts: { json?: unknown }) => {
      last = { path, json: opts?.json };
      return impl(path, opts?.json);
    },
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
  it('optimistically inserts then promotes temp→real on the send ack (one row, is-from-me)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const { http } = fakeHttp(async () => ({ guid: 'real-ct', viaPrivateApi: true }));
    await sendContactMessage(db, http, {
      chatGuid: 'c1',
      contact: { firstName: 'Craig', lastName: 'Federighi', phones: [{ number: '+15551234567' }] },
    });
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
    await seedChat(db, 'c1');
    raw.prepare("UPDATE chats SET latest_message_date = 321 WHERE guid = 'c1'").run();
    let drain: Promise<void> | undefined;
    let triggerRan = false;
    raw.function('pause_contact_during_chat_update', () => {
      triggerRan = true;
      drain = pauseRealtimeDeliveries();
      return 0;
    });
    raw.exec(`CREATE TRIGGER pause_contact_during_chat_update
      AFTER UPDATE OF latest_message_date ON chats
      WHEN NEW.guid = 'c1' AND NEW.latest_message_date = 1000
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
          { chatGuid: 'c1', contact: { firstName: 'Retired', lastName: 'Contact' } },
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
      expect(one(raw, "SELECT latest_message_date d FROM chats WHERE guid='c1'").d).toBe(321);

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
                        q.temp_guid AS queueGuid, q.kind, q.payload,
                        c.latest_message_date AS chatDate
                   FROM messages m
                   JOIN outgoing_queue q ON q.temp_guid = m.guid
                   JOIN chats c ON c.id = m.chat_id`,
              );
              return { guid: 'real-contact-after-retirement', viaPrivateApi: true };
            }).http,
            {
              chatGuid: 'c1',
              contact: freshContact,
              selectedMessageGuid: 'reply-target',
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
        replyGuid: 'reply-target',
        chatDate: 2_000,
      });
      expect(JSON.parse(String(optimisticState?.payload))).toEqual({
        firstName: 'Grace',
        lastName: 'Hopper',
        phones: [{ label: 'work', number: '+15551234000' }],
        emails: [{ label: 'home', address: 'grace@example.test' }],
        selectedMessageGuid: 'reply-target',
      });
      expect(String(optimisticState?.payload)).not.toContain('private-device-contact-id');
      expect(String(optimisticState?.payload)).not.toContain('private-contact-photo');
      expect(String(optimisticState?.payload)).not.toContain('private selected message body');
      expect(requestBody).toMatchObject({
        chatGuid: 'c1',
        tempGuid: result?.tempGuid,
        firstName: 'Grace',
        lastName: 'Hopper',
        selectedMessageGuid: 'reply-target',
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
    await seedChat(db, 'c1');
    const cap = fakeHttp(async () => ({ guid: 'g' }));
    await sendContactMessage(db, cap.http, {
      chatGuid: 'c1',
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
    expect(body.chatGuid).toBe('c1');
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
    await seedChat(db, 'c1');
    const { http } = fakeHttp(async () => {
      throw new ApiError('unauthorized', 'nope', 401);
    });
    await sendContactMessage(db, http, { chatGuid: 'c1', contact: { firstName: 'Nope' } });
    expect(countMessages(raw)).toBe(1);
    const row = raw.prepare('SELECT send_state s, error e FROM messages').get() as {
      s: string;
      e: number;
    };
    expect(row.s).toBe('error');
    expect(row.e).toBe(401);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[send-contact] failed for chat c1 (code 401, HTTP 401): nope',
    );
    warn.mockRestore();
  });

  it('throws (sends nothing) for a content-less contact', async () => {
    const { db } = await createTestDb();
    await seedChat(db, 'c1');
    const { http } = fakeHttp(async () => ({ guid: 'x' }));
    await expect(sendContactMessage(db, http, { chatGuid: 'c1', contact: {} })).rejects.toThrow(
      /name, organization, phone, or email/,
    );
  });

  it('throws for an unknown chat', async () => {
    const { db } = await createTestDb();
    const { http } = fakeHttp(async () => ({ guid: 'x' }));
    await expect(
      sendContactMessage(db, http, { chatGuid: 'nope', contact: { firstName: 'A' } }),
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
  const contact = {
    firstName: 'Craig',
    lastName: 'Federighi',
    organization: 'Apple',
    emails: [{ address: 'craig@apple.com' }],
  };

  /** Fail the first send, then drain the queue past the 30s backoff and record every POST. */
  async function failThenDrain() {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const t = 1_000_000;

    const { http: failing } = fakeHttp(async () => {
      throw new ApiError('unauthorized', 'nope', 401);
    });
    await sendContactMessage(db, failing, { chatGuid: 'c1', contact }, t);

    const posts: { path: string; json: Record<string, unknown> }[] = [];
    const retryHttp = {
      post: (path: string, _schema: unknown, opts: { json?: unknown }) => {
        posts.push({ path, json: (opts?.json ?? {}) as Record<string, unknown> });
        return Promise.resolve({ guid: 'server-guid-1' });
      },
    } as unknown as HttpClient;

    // The failure path schedules the backoff off real `Date.now()` (every send service omits
    // the injected `now` there), so drain past outgoingBackoffMs(1) = 30s of REAL time.
    const later = Date.now() + 31_000;
    const res = await runOutgoingQueue(db, retryHttp, noAttachmentIo, later);
    return { db, raw, posts, res };
  }

  it('queues the send under kind "contact" carrying the structured fields (not the name as text)', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const { http } = fakeHttp(async () => {
      throw new ApiError('unauthorized', 'nope', 401);
    });
    // Assert BEFORE any drain — a successful retry deletes the queue row.
    await sendContactMessage(db, http, { chatGuid: 'c1', contact }, 1_000_000);

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
      '[send-contact] failed for chat c1 (code 401, HTTP 401): nope',
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
      '[send-contact] failed for chat c1 (code 401, HTTP 401): nope',
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
      '[send-contact] failed for chat c1 (code 401, HTTP 401): nope',
    );
    warn.mockRestore();
  });
});
