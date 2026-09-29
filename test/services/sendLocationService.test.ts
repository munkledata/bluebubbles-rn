import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { CURRENT_LOCATION_MAX_REPLAY_AGE_MS } from '@core/api/endpoints/messages';
import { Chat, ServerInfo } from '@core/models';
import { logger } from '@core/secure';
import {
  claimFailedOutgoingForRetry,
  OUTGOING_MAX_ATTEMPTS,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { ClientErrorCode } from '@utils';
import { runOutgoingQueue, type OutgoingQueueIO } from '@/services/send/outgoingQueueService';
import { fixedRcsCapabilitySource } from '@/services/send/rcsAttemptCapability';
import { sendCurrentLocationMessage } from '@/services/send/sendLocationService';
import { createTestDb } from '../support/testDb';

const noAttachmentIo: OutgoingQueueIO = {
  upload: () => Promise.reject(new Error('location retry must not upload a file')),
  fileExists: () => Promise.resolve(false),
};

function fakeHttp(impl: (path: string, json: unknown) => Promise<unknown>): {
  http: HttpClient;
  requests: Array<{ path: string; json: unknown }>;
} {
  const requests: Array<{ path: string; json: unknown }> = [];
  let http!: HttpClient;
  http = {
    get: () => Promise.resolve({ version: 'test', supports_imessage_location: true }),
    post: (path: string, _schema: unknown, options: { json?: unknown }) => {
      requests.push({ path, json: options.json });
      return impl(path, options.json);
    },
    pinTransport: () => http,
    isTransportCurrent: () => true,
    assertTransportCurrent: () => undefined,
  } as unknown as HttpClient;
  return { http, requests };
}

async function seedProvenImessageChat(db: AppDatabase, guid = 'any;-;+15551234567') {
  const participant = { address: '+15551234567', service: 'iMessage' as const };
  const handles = await upsertHandles(db, [participant]);
  await upsertChats(db, [Chat.parse({ guid, style: 45, participants: [participant] })], handles);
  return guid;
}

const capability = () =>
  fixedRcsCapabilitySource(
    ServerInfo.parse({ version: '2.0.0', supports_imessage_location: true }),
  );

function one(raw: Database.Database, sql: string): Record<string, unknown> {
  return raw.prepare(sql).get() as Record<string, unknown>;
}

describe('sendCurrentLocationMessage', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => warn.mockRestore());

  it('queues one bounded coordinate pair, POSTs it, and promotes the exact helper ack', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = await seedProvenImessageChat(db);
    const transport = fakeHttp(async () => ({ guid: 'real-location-guid', viaPrivateApi: true }));
    const onQueued = jest.fn();

    const result = await sendCurrentLocationMessage(
      db,
      transport.http,
      { chatGuid, coordinates: { latitude: 39.7392, longitude: -104.9903 } },
      10_000,
      undefined,
      capability(),
      onQueued,
    );

    expect(onQueued).toHaveBeenCalledWith(result.tempGuid);
    expect(transport.requests).toEqual([
      {
        path: '/message/location',
        json: {
          chatGuid,
          tempGuid: result.tempGuid,
          latitude: 39.7392,
          longitude: -104.9903,
        },
      },
    ]);
    expect(one(raw, 'SELECT guid, text, send_state AS state FROM messages')).toEqual({
      guid: 'real-location-guid',
      text: 'Current Location',
      state: 'sent',
    });
    expect(one(raw, 'SELECT COUNT(*) AS count FROM outgoing_queue').count).toBe(0);
  });

  it('does not read, queue, or POST when the exact server capability is absent', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = await seedProvenImessageChat(db);
    const transport = fakeHttp(async () => ({ guid: 'must-not-send', viaPrivateApi: true }));

    await expect(
      sendCurrentLocationMessage(
        db,
        transport.http,
        { chatGuid, coordinates: { latitude: 1, longitude: 2 } },
        10_000,
        undefined,
        fixedRcsCapabilitySource(ServerInfo.parse({ version: '2.0.0' })),
      ),
    ).rejects.toThrow('cannot send a current location');

    expect(transport.requests).toHaveLength(0);
    expect(one(raw, 'SELECT COUNT(*) AS count FROM messages').count).toBe(0);
    expect(one(raw, 'SELECT COUNT(*) AS count FROM outgoing_queue').count).toBe(0);
  });

  it('keeps a temporary helper refusal retryable and reuses the original idempotency key', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = await seedProvenImessageChat(db);
    const first = fakeHttp(async () => {
      throw ApiError.fromStatus(
        503,
        'temporarily unavailable',
        undefined,
        'imessage_location_unavailable',
      );
    });
    const initial = await sendCurrentLocationMessage(
      db,
      first.http,
      { chatGuid, coordinates: { latitude: 39.7, longitude: -105 } },
      Date.now(),
      undefined,
      capability(),
    );
    raw.prepare('UPDATE outgoing_queue SET next_retry_at = 0').run();

    const retry = fakeHttp(async () => ({ guid: 'real-after-retry', viaPrivateApi: true }));
    const beforeDisabledDrain = one(
      raw,
      'SELECT attempts, payload, temp_guid AS tempGuid FROM outgoing_queue',
    );
    await runOutgoingQueue(
      db,
      retry.http,
      noAttachmentIo,
      Date.now(),
      undefined,
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      () => false,
    );
    expect(retry.requests).toHaveLength(0);
    expect(one(raw, 'SELECT attempts, payload, temp_guid AS tempGuid FROM outgoing_queue')).toEqual(
      beforeDisabledDrain,
    );

    await runOutgoingQueue(
      db,
      retry.http,
      noAttachmentIo,
      Date.now(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => true,
    );

    expect((retry.requests[0]?.json as Record<string, unknown>).tempGuid).toBe(initial.tempGuid);
    expect(one(raw, 'SELECT guid, send_state AS state FROM messages')).toMatchObject({
      guid: 'real-after-retry',
      state: 'sent',
    });
  });

  it.each(['idempotency_outcome_unknown', 'imessage_location_outcome_unknown'])(
    'retires %s without an automatic duplicate retry',
    async (serverErrorType) => {
      const { db, raw } = await createTestDb();
      const chatGuid = await seedProvenImessageChat(db);
      const transport = fakeHttp(async () => {
        throw ApiError.fromStatus(500, 'unknown outcome', undefined, serverErrorType);
      });

      await sendCurrentLocationMessage(
        db,
        transport.http,
        { chatGuid, coordinates: { latitude: 39.7, longitude: -105 } },
        Date.now(),
        undefined,
        capability(),
      );

      expect(one(raw, 'SELECT attempts FROM outgoing_queue').attempts).toBe(OUTGOING_MAX_ATTEMPTS);
      expect(one(raw, 'SELECT payload FROM outgoing_queue').payload).toBe('{}');
      expect(one(raw, 'SELECT error, error_message AS detail FROM messages')).toEqual({
        error: ClientErrorCode.locationDeliveryUnconfirmed,
        detail: 'This location may have been delivered. Check Messages before sending a new copy.',
      });
      const before = transport.requests.length;
      await expect(
        claimFailedOutgoingForRetry(
          db,
          String(one(raw, 'SELECT temp_guid AS tempGuid FROM outgoing_queue').tempGuid),
          Date.now,
          undefined,
          undefined,
          () => true,
        ),
      ).resolves.toMatchObject({ claim: 'unsendable' });
      await runOutgoingQueue(
        db,
        transport.http,
        noAttachmentIo,
        Date.now() + 60_000,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => true,
      );
      expect(transport.requests).toHaveLength(before);
    },
  );

  it.each([
    ['idempotency_key_reused', 409],
    ['imessage_location_invalid_target', 400],
  ])(
    'retires proven pre-dispatch rejection %s as not sent and non-retryable',
    async (serverErrorType, status) => {
      const { db, raw } = await createTestDb();
      const chatGuid = await seedProvenImessageChat(db);
      const transport = fakeHttp(async () => {
        throw ApiError.fromStatus(status, 'rejected', undefined, serverErrorType);
      });

      await sendCurrentLocationMessage(
        db,
        transport.http,
        { chatGuid, coordinates: { latitude: 39.7, longitude: -105 } },
        Date.now(),
        undefined,
        capability(),
      );

      expect(one(raw, 'SELECT attempts, payload FROM outgoing_queue')).toEqual({
        attempts: OUTGOING_MAX_ATTEMPTS,
        payload: '{}',
      });
      expect(one(raw, 'SELECT error, error_message AS detail FROM messages')).toEqual({
        error: ClientErrorCode.locationRejected,
        detail: 'The server rejected this location before dispatch. This attempt was not sent.',
      });
      await expect(
        claimFailedOutgoingForRetry(
          db,
          String(one(raw, 'SELECT temp_guid AS tempGuid FROM outgoing_queue').tempGuid),
          Date.now,
          undefined,
          undefined,
          () => true,
        ),
      ).resolves.toMatchObject({ claim: 'unsendable' });
    },
  );

  it('treats a malformed helper acknowledgement as outcome-unknown', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = await seedProvenImessageChat(db);
    const transport = fakeHttp(async () => ({ guid: null, viaPrivateApi: true }));

    await sendCurrentLocationMessage(
      db,
      transport.http,
      { chatGuid, coordinates: { latitude: 39.7, longitude: -105 } },
      Date.now(),
      undefined,
      capability(),
    );

    expect(one(raw, 'SELECT attempts FROM outgoing_queue').attempts).toBe(OUTGOING_MAX_ATTEMPTS);
    expect(one(raw, 'SELECT error FROM messages').error).toBe(
      ClientErrorCode.locationDeliveryUnconfirmed,
    );
  });

  it('retires malformed durable coordinates without making a request', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = await seedProvenImessageChat(db);
    const first = fakeHttp(async () => {
      throw ApiError.fromStatus(
        503,
        'temporarily unavailable',
        undefined,
        'imessage_location_unavailable',
      );
    });
    await sendCurrentLocationMessage(
      db,
      first.http,
      { chatGuid, coordinates: { latitude: 39.7, longitude: -105 } },
      Date.now(),
      undefined,
      capability(),
    );
    raw.prepare("UPDATE outgoing_queue SET payload = '{bad json', next_retry_at = 0").run();
    const retry = fakeHttp(async () => ({ guid: 'must-not-send', viaPrivateApi: true }));

    await runOutgoingQueue(
      db,
      retry.http,
      noAttachmentIo,
      Date.now(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => true,
    );

    expect(retry.requests).toHaveLength(0);
    expect(one(raw, 'SELECT attempts FROM outgoing_queue').attempts).toBe(OUTGOING_MAX_ATTEMPTS);
  });

  it('never replays a location after its 15-minute current-location window', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = await seedProvenImessageChat(db);
    const first = fakeHttp(async () => {
      throw ApiError.fromStatus(
        503,
        'temporarily unavailable',
        undefined,
        'imessage_location_unavailable',
      );
    });
    await sendCurrentLocationMessage(
      db,
      first.http,
      { chatGuid, coordinates: { latitude: 39.7, longitude: -105 } },
      Date.now(),
      undefined,
      capability(),
    );
    const now = Date.now();
    raw
      .prepare('UPDATE outgoing_queue SET created_at = ?, next_retry_at = 0')
      .run(now - CURRENT_LOCATION_MAX_REPLAY_AGE_MS);
    const retry = fakeHttp(async () => ({ guid: 'must-not-send', viaPrivateApi: true }));

    await runOutgoingQueue(
      db,
      retry.http,
      noAttachmentIo,
      now,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => true,
    );

    expect(retry.requests).toHaveLength(0);
    expect(one(raw, 'SELECT error FROM messages').error).toBe(
      ClientErrorCode.locationDeliveryUnconfirmed,
    );
    expect(one(raw, 'SELECT payload FROM outgoing_queue').payload).toBe('{}');
  });

  it('scrubs an invalid timestamp even while the server capability is unavailable', async () => {
    const { db, raw } = await createTestDb();
    const chatGuid = await seedProvenImessageChat(db);
    const first = fakeHttp(async () => {
      throw ApiError.fromStatus(
        503,
        'temporarily unavailable',
        undefined,
        'imessage_location_unavailable',
      );
    });
    await sendCurrentLocationMessage(
      db,
      first.http,
      { chatGuid, coordinates: { latitude: 39.7, longitude: -105 } },
      Date.now(),
      undefined,
      capability(),
    );
    raw
      .prepare('UPDATE outgoing_queue SET created_at = NULL, attempts = ?, next_retry_at = 0')
      .run(OUTGOING_MAX_ATTEMPTS);
    const retry = fakeHttp(async () => ({ guid: 'must-not-send', viaPrivateApi: true }));

    await runOutgoingQueue(
      db,
      retry.http,
      noAttachmentIo,
      Date.now(),
      undefined,
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      () => false,
    );

    expect(retry.requests).toHaveLength(0);
    expect(one(raw, 'SELECT attempts, payload FROM outgoing_queue')).toEqual({
      attempts: OUTGOING_MAX_ATTEMPTS,
      payload: '{}',
    });
  });
});
