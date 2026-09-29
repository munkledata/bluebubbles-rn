import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient, RequestOptions } from '@core/api/http';
import { ServerInfo } from '@core/models';
import { claimFailedOutgoingForRetry, OUTGOING_MAX_ATTEMPTS } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { ClientErrorCode } from '@utils';
import {
  fixedRcsCapabilitySource,
  type RcsCapabilityLease,
} from '@/services/send/rcsAttemptCapability';
import { sendIMessageEffect } from '@/services/send/sendEffectService';
import { createTestDb } from '../support/testDb';

const CHAT_GUID = 'iMessage;-;+15551234567';
const SLAM = 'com.apple.MobileSMS.expressivesend.impact';

function seedChat(raw: Database.Database, participantCount = 1): void {
  const chat = raw.prepare('INSERT INTO chats(guid, style) VALUES (?, 45)').run(CHAT_GUID);
  for (let index = 0; index < participantCount; index += 1) {
    const handle = raw
      .prepare('INSERT INTO handles(address, service) VALUES (?, ?)')
      .run(`+1555123456${index}`, 'iMessage');
    raw
      .prepare('INSERT INTO chat_handles(chat_id, handle_id) VALUES (?, ?)')
      .run(Number(chat.lastInsertRowid), Number(handle.lastInsertRowid));
  }
}

function capability() {
  return fixedRcsCapabilitySource(
    ServerInfo.parse({ version: 'test', supports_imessage_effects: true }),
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
      origin: 'https://effect.test',
      headers: {},
      password: 'test',
      transportRevision: 1,
      buildUrl: (path: string) => `https://effect.test/api/v1${path}`,
    }),
  } as unknown as HttpClient;
  return { http, post };
}

function one(raw: Database.Database, sql: string): Record<string, unknown> {
  return raw.prepare(sql).get() as Record<string, unknown>;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('sendIMessageEffect', () => {
  let db: AppDatabase;
  let raw: Database.Database;

  beforeEach(async () => {
    ({ db, raw } = await createTestDb());
    seedChat(raw);
  });

  afterEach(() => raw.close());

  it('admits one effect row, sends the exact body once, and promotes the helper GUID', async () => {
    const transport = fakeHttp(async () => ({ guid: 'real-effect-guid', viaPrivateApi: true }));

    const result = await sendIMessageEffect(
      db,
      transport.http,
      { chatGuid: CHAT_GUID, text: 'boom', effectId: SLAM },
      10_000,
      undefined,
      capability(),
    );

    expect(result).toMatchObject({ status: 'accepted', tempGuid: expect.stringMatching(/^temp-/) });
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post.mock.calls[0]).toEqual([
      '/message/effect',
      expect.anything(),
      {
        captureErrorDetail: true,
        retry: false,
        json: {
          chatGuid: CHAT_GUID,
          tempGuid: result.tempGuid,
          message: 'boom',
          effectId: SLAM,
        },
      },
    ]);
    expect(
      one(
        raw,
        `SELECT guid, text, send_state AS state, expressive_send_style_id AS effect
           FROM messages WHERE date_deleted IS NULL`,
      ),
    ).toEqual({ guid: 'real-effect-guid', text: 'boom', state: 'sent', effect: SLAM });
    expect(one(raw, 'SELECT COUNT(*) AS count FROM outgoing_queue').count).toBe(0);
  });

  it('rolls back a definite typed refusal, preserving the caller-owned draft for another action', async () => {
    const transport = fakeHttp(async () => {
      throw ApiError.fromStatus(503, 'not dispatched', undefined, 'imessage_effect_unavailable');
    });

    const result = await sendIMessageEffect(
      db,
      transport.http,
      { chatGuid: CHAT_GUID, text: 'keep this draft', effectId: SLAM },
      10_000,
      undefined,
      capability(),
    );

    expect(result.status).toBe('rejected');
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(one(raw, 'SELECT date_deleted AS deleted FROM messages').deleted).toBe(10_000);
    expect(one(raw, 'SELECT COUNT(*) AS count FROM outgoing_queue').count).toBe(0);
  });

  it.each(['imessage_effect_outcome_unknown', 'idempotency_outcome_unknown'])(
    'retires %s as delivery-unconfirmed and never admits it to retry',
    async (serverErrorType) => {
      const transport = fakeHttp(async () => {
        throw ApiError.fromStatus(500, 'unknown outcome', undefined, serverErrorType);
      });

      const result = await sendIMessageEffect(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, text: 'maybe sent', effectId: SLAM },
        10_000,
        undefined,
        capability(),
      );

      expect(result.status).toBe('outcome-unknown');
      expect(transport.post).toHaveBeenCalledTimes(1);
      expect(
        one(
          raw,
          `SELECT send_state AS state, error, expressive_send_style_id AS effect
             FROM messages WHERE guid = '${result.tempGuid}'`,
        ),
      ).toEqual({
        state: 'error',
        error: ClientErrorCode.effectDeliveryUnconfirmed,
        effect: SLAM,
      });
      expect(one(raw, 'SELECT attempts FROM outgoing_queue').attempts).toBe(OUTGOING_MAX_ATTEMPTS);
      await expect(claimFailedOutgoingForRetry(db, result.tempGuid!)).resolves.toMatchObject({
        claim: 'unsendable',
      });
      expect(transport.post).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses a second submission while the first request is in flight', async () => {
    const response = deferred<unknown>();
    const started = deferred<void>();
    const transport = fakeHttp(async () => {
      started.resolve();
      return response.promise;
    });
    const first = sendIMessageEffect(
      db,
      transport.http,
      { chatGuid: CHAT_GUID, text: 'first', effectId: SLAM },
      10_000,
      undefined,
      capability(),
    );
    await started.promise;

    await expect(
      sendIMessageEffect(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, text: 'second', effectId: SLAM },
        10_001,
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).toHaveBeenCalledTimes(1);

    response.resolve({ guid: 'real-first', viaPrivateApi: true });
    await expect(first).resolves.toMatchObject({ status: 'accepted' });
  });

  it('retires a late success as outcome-unknown after its capability lease retires', async () => {
    const response = deferred<unknown>();
    const started = deferred<void>();
    const transport = fakeHttp(async () => {
      started.resolve();
      return response.promise;
    });
    let current = true;
    const info = ServerInfo.parse({ version: 'test', supports_imessage_effects: true });
    const source: RcsCapabilityLease = {
      kind: 'session',
      origin: 'https://effect.test',
      revision: 1,
      serverInfo: info,
      isCurrent: () => current,
      publish: () => false,
    };
    const result = sendIMessageEffect(
      db,
      transport.http,
      { chatGuid: CHAT_GUID, text: 'late result', effectId: SLAM },
      10_000,
      undefined,
      source,
    );
    await started.promise;
    current = false;
    response.resolve({ guid: 'must-not-promote', viaPrivateApi: true });

    const outcome = await result;
    expect(outcome).toMatchObject({ status: 'outcome-unknown', tempGuid: expect.any(String) });
    expect(
      one(raw, "SELECT COUNT(*) AS count FROM messages WHERE guid = 'must-not-promote'").count,
    ).toBe(0);
    expect(
      one(
        raw,
        `SELECT send_state AS state, error
           FROM messages WHERE guid = '${outcome.tempGuid}'`,
      ),
    ).toEqual({ state: 'error', error: ClientErrorCode.effectDeliveryUnconfirmed });
    expect(one(raw, 'SELECT attempts FROM outgoing_queue').attempts).toBe(OUTGOING_MAX_ATTEMPTS);
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
    const result = sendIMessageEffect(
      db,
      transport.http,
      { chatGuid: CHAT_GUID, text: 'old account result', effectId: SLAM },
      10_000,
      () => accountCurrent,
      capability(),
    );
    await started.promise;
    accountCurrent = false;
    response.resolve({ guid: 'must-not-cross-account', viaPrivateApi: true });

    const outcome = await result;
    expect(outcome).toMatchObject({ status: 'outcome-unknown', tempGuid: expect.any(String) });
    expect(
      one(raw, "SELECT COUNT(*) AS count FROM messages WHERE guid = 'must-not-cross-account'")
        .count,
    ).toBe(0);
    expect(
      one(raw, `SELECT send_state AS state FROM messages WHERE guid = '${outcome.tempGuid}'`),
    ).toEqual({ state: 'sending' });
    expect(one(raw, 'SELECT attempts FROM outgoing_queue').attempts).toBe(0);
    expect(transport.post).toHaveBeenCalledTimes(1);
  });
});
