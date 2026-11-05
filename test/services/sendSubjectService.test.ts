import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient, RequestOptions } from '@core/api/http';
import { ServerInfo } from '@core/models';
import {
  claimFailedOutgoingForRetry,
  insertOutgoingText,
  OUTGOING_MAX_ATTEMPTS,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { ClientErrorCode } from '@utils';
import { fixedRcsCapabilitySource } from '@/services/send/rcsAttemptCapability';
import { sendIMessageSubject } from '@/services/send/sendSubjectService';
import { runOutgoingQueue } from '@/services/send/outgoingQueueService';
import { createTestDb } from '../support/testDb';

const DIRECT = 'iMessage;-;+15551234567';
const GROUP = 'any;+;chat-subject-1';
const TEXT = 'Are we still on for Friday?';
const SUBJECT = 'Dinner plans';
const MAYBE_DELIVERED =
  'This message may have been delivered. Check Messages before sending a new copy.';

function seedChat(raw: Database.Database, chatGuid: string, services: string[]): void {
  const style = chatGuid.includes(';+;') ? 43 : 45;
  const chat = raw.prepare('INSERT INTO chats(guid, style) VALUES (?, ?)').run(chatGuid, style);
  services.forEach((service, index) => {
    const handle = raw
      .prepare('INSERT INTO handles(address, service) VALUES (?, ?)')
      .run(`member${index}@example.com`, service);
    raw
      .prepare('INSERT INTO chat_handles(chat_id, handle_id) VALUES (?, ?)')
      .run(Number(chat.lastInsertRowid), Number(handle.lastInsertRowid));
  });
}

function capability(enabled = true) {
  return fixedRcsCapabilitySource(
    ServerInfo.parse({ version: 'test', supports_imessage_subject: enabled }),
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
      origin: 'https://subject.test',
      headers: {},
      password: 'test',
      transportRevision: 1,
      buildUrl: (path: string) => `https://subject.test/api/v1${path}`,
    }),
  } as unknown as HttpClient;
  return { http, post };
}

function one(raw: Database.Database, sql: string): Record<string, unknown> {
  return raw.prepare(sql).get() as Record<string, unknown>;
}

const liveRows = (raw: Database.Database) =>
  one(raw, 'SELECT COUNT(*) AS c FROM messages WHERE date_deleted IS NULL').c;

describe('sendIMessageSubject (FP-006)', () => {
  let db: AppDatabase;
  let raw: Database.Database;

  beforeEach(async () => {
    ({ db, raw } = await createTestDb());
  });

  afterEach(() => raw.close());

  it.each([
    ['a one-to-one chat', DIRECT, ['iMessage']],
    ['an all-iMessage group', GROUP, ['iMessage', 'iMessage']],
  ])(
    'sends text and subject once to %s, marked one-shot, and promotes the helper guid',
    async (_label, chatGuid, services) => {
      seedChat(raw, chatGuid, services);
      let payloadAtDispatch: unknown;
      const transport = fakeHttp(async () => {
        payloadAtDispatch = JSON.parse(
          String(one(raw, 'SELECT payload FROM outgoing_queue').payload),
        );
        return { guid: 'subject-helper-guid', viaPrivateApi: true };
      });
      const result = await sendIMessageSubject(
        db,
        transport.http,
        { chatGuid, text: TEXT, subject: SUBJECT },
        10_000,
        undefined,
        capability(),
      );

      expect(result).toMatchObject({ status: 'accepted' });
      expect(transport.post).toHaveBeenCalledTimes(1);
      expect(transport.post.mock.calls[0]?.[0]).toBe('/message/text');
      expect(transport.post.mock.calls[0]?.[2]).toMatchObject({
        retry: false,
        json: { chatGuid, text: TEXT, subject: SUBJECT, tempGuid: expect.stringMatching(/^temp-/) },
      });
      expect(payloadAtDispatch).toMatchObject({
        message: TEXT,
        subject: SUBJECT,
        imessageSubjectV1: true,
      });
      expect(one(raw, `SELECT guid, text, subject, send_state AS state FROM messages`)).toEqual({
        guid: 'subject-helper-guid',
        text: TEXT,
        subject: SUBJECT,
        state: 'sent',
      });
      expect(one(raw, 'SELECT COUNT(*) AS c FROM outgoing_queue').c).toBe(0);
    },
  );

  it.each([
    ['the subject switch is off', DIRECT, ['iMessage'], false],
    ['a group member is not iMessage', GROUP, ['iMessage', 'SMS'], true],
    ['the one-to-one chat is SMS', DIRECT, ['SMS'], true],
  ])('refuses before storing anything when %s', async (_label, chatGuid, services, enabled) => {
    seedChat(raw, chatGuid, services);
    const transport = fakeHttp(async () => ({ guid: 'never' }));
    await expect(
      sendIMessageSubject(
        db,
        transport.http,
        { chatGuid, text: TEXT, subject: SUBJECT },
        10_000,
        undefined,
        capability(enabled),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).not.toHaveBeenCalled();
    expect(liveRows(raw)).toBe(0);
  });

  it.each([
    ['blank', ''],
    ['multi-line', 'two\nlines'],
  ])('rejects a %s subject before any work', async (_label, subject) => {
    seedChat(raw, DIRECT, ['iMessage']);
    const transport = fakeHttp(async () => ({ guid: 'never' }));
    await expect(
      sendIMessageSubject(
        db,
        transport.http,
        { chatGuid: DIRECT, text: TEXT, subject },
        10_000,
        undefined,
        capability(),
      ),
    ).rejects.toThrow();
    expect(transport.post).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid target', 400, 'imessage_restored_send_invalid_target'],
    ['helper unavailable', 503, 'imessage_restored_send_unavailable'],
    ['helper refused', 409, 'imessage_restored_send_rejected'],
  ])('removes the bubble on a definite refusal (%s)', async (_label, status, type) => {
    seedChat(raw, DIRECT, ['iMessage']);
    const transport = fakeHttp(async () => {
      throw ApiError.fromStatus(status, 'refused', undefined, type);
    });
    const result = await sendIMessageSubject(
      db,
      transport.http,
      { chatGuid: DIRECT, text: TEXT, subject: SUBJECT },
      10_000,
      undefined,
      capability(),
    );
    expect(result).toMatchObject({ status: 'rejected' });
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(liveRows(raw)).toBe(0);
  });

  it.each([
    ['helper outcome unknown', 409, 'imessage_restored_send_outcome_unknown'],
    ['retry-ledger outcome unknown', 500, 'idempotency_outcome_unknown'],
  ])(
    'keeps the bubble as "may have been delivered" and never resends after %s',
    async (_label, status, type) => {
      seedChat(raw, DIRECT, ['iMessage']);
      const transport = fakeHttp(async () => {
        throw ApiError.fromStatus(status, 'unknown', undefined, type);
      });
      const result = await sendIMessageSubject(
        db,
        transport.http,
        { chatGuid: DIRECT, text: TEXT, subject: SUBJECT },
        10_000,
        undefined,
        capability(),
      );
      expect(result).toMatchObject({ status: 'outcome-unknown' });
      expect(transport.post).toHaveBeenCalledTimes(1);
      const row = one(
        raw,
        `SELECT guid, send_state AS state, error, subject FROM messages WHERE date_deleted IS NULL`,
      );
      expect(row).toMatchObject({
        state: 'error',
        error: ClientErrorCode.messageDeliveryUnconfirmed,
        subject: SUBJECT,
      });
      await expect(claimFailedOutgoingForRetry(db, String(row.guid))).resolves.toEqual({
        claim: 'unsendable',
      });
    },
  );

  it('never manually or automatically replays a recovered subject row', async () => {
    seedChat(raw, DIRECT, ['iMessage']);
    await insertOutgoingText(db, {
      tempGuid: 'temp-subject-recovery',
      chatGuid: DIRECT,
      text: TEXT,
      subject: SUBJECT,
      oneShotSubject: true,
      now: 1_000,
    });
    raw
      .prepare(
        `UPDATE messages SET send_state = 'error', error = ?
          WHERE guid = 'temp-subject-recovery'`,
      )
      .run(ClientErrorCode.clientError);
    await expect(claimFailedOutgoingForRetry(db, 'temp-subject-recovery')).resolves.toEqual({
      claim: 'unsendable',
    });

    raw
      .prepare(
        `UPDATE messages SET send_state = 'sending', error = 0
          WHERE guid = 'temp-subject-recovery'`,
      )
      .run();
    raw
      .prepare(
        `UPDATE outgoing_queue SET created_at = 0, next_retry_at = 0
          WHERE temp_guid = 'temp-subject-recovery'`,
      )
      .run();
    const transport = fakeHttp(async () => {
      throw new Error('a marked subject message must never reach HTTP recovery');
    });
    await expect(
      runOutgoingQueue(
        db,
        transport.http,
        {
          fileExists: async () => false,
          upload: async () => {
            throw new Error('subject recovery must never upload');
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
           FROM messages WHERE guid = 'temp-subject-recovery'`,
      ),
    ).toEqual({
      state: 'error',
      error: ClientErrorCode.messageDeliveryUnconfirmed,
      detail: MAYBE_DELIVERED,
    });
  });
});
