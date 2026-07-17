import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { Chat } from '@core/models';
import { upsertChats, upsertHandles } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import {
  contactDisplayName,
  hasContactContent,
  sendContactMessage,
} from '@/services/send/sendContactService';
import { createTestDb } from '../support/testDb';

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
  await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'craig@apple.com' }] })], handles);
}

const countMessages = (raw: Database.Database) =>
  (raw.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c;

describe('contactDisplayName', () => {
  it('prefers first+last, then org, then phone, then email, then a generic fallback', () => {
    expect(contactDisplayName({ firstName: 'Craig', lastName: 'Federighi' })).toBe('Craig Federighi');
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
    const row = raw.prepare('SELECT guid, send_state s, is_from_me f, text FROM messages').get() as {
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

  it('POSTs structured fields to /message/contact, omitting empty phone/email arrays', async () => {
    const { db } = await createTestDb();
    await seedChat(db, 'c1');
    const cap = fakeHttp(async () => ({ guid: 'g' }));
    await sendContactMessage(db, cap.http, {
      chatGuid: 'c1',
      contact: { firstName: 'Tim', organization: 'Apple', phones: [], emails: [{ address: 'tim@apple.com' }] },
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
  });

  it('throws (sends nothing) for a content-less contact', async () => {
    const { db } = await createTestDb();
    await seedChat(db, 'c1');
    const { http } = fakeHttp(async () => ({ guid: 'x' }));
    await expect(
      sendContactMessage(db, http, { chatGuid: 'c1', contact: {} }),
    ).rejects.toThrow(/name, organization, phone, or email/);
  });

  it('throws for an unknown chat', async () => {
    const { db } = await createTestDb();
    const { http } = fakeHttp(async () => ({ guid: 'x' }));
    await expect(
      sendContactMessage(db, http, { chatGuid: 'nope', contact: { firstName: 'A' } }),
    ).rejects.toThrow(/unknown chat/);
  });
});
