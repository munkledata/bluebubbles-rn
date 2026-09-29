import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient, RequestOptions } from '@core/api/http';
import { ServerInfo } from '@core/models';
import { DbCommitGuardRejectedError } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  prepareExactIMessageGroupPhotoSet,
  removeExactIMessageGroupPhoto,
  type GroupPhotoUploader,
} from '@/services/groupPhotoService';
import {
  fixedRcsCapabilitySource,
  type RcsCapabilityLease,
} from '@/services/send/rcsAttemptCapability';
import { uploadRegistry } from '@/services/send/uploadControl';
import { createTestDb } from '../support/testDb';

const CHAT_GUID = 'iMessage;+;chat123456789';
const PHOTO = {
  uri: 'file:///picked/group-photo.jpg',
  name: 'group-photo.jpg',
  mimeType: 'image/jpeg',
  size: 4_096,
};

function seedGroup(raw: Database.Database): void {
  const chat = raw.prepare('INSERT INTO chats(guid, style) VALUES (?, 43)').run(CHAT_GUID);
  for (const address of ['+15551234567', '+15557654321']) {
    const handle = raw
      .prepare('INSERT INTO handles(address, service) VALUES (?, ?)')
      .run(address, 'iMessage');
    raw
      .prepare('INSERT INTO chat_handles(chat_id, handle_id) VALUES (?, ?)')
      .run(Number(chat.lastInsertRowid), Number(handle.lastInsertRowid));
  }
}

function capability(enabled = true) {
  return fixedRcsCapabilitySource(
    ServerInfo.parse({ version: 'test', supports_imessage_group_photo: enabled }),
  );
}

function fakeHttp(
  removeResult: unknown = {
    removed: true,
    guid: CHAT_GUID,
    operation: 'remove',
  },
): { http: HttpClient; remove: jest.Mock; pinTransport: jest.Mock } {
  const remove = jest.fn((_path: string, _schema: unknown, _options: RequestOptions) =>
    Promise.resolve(removeResult),
  );
  let http!: HttpClient;
  const pinTransport = jest.fn(() => http);
  http = {
    delete: remove,
    pinTransport,
    isTransportCurrent: () => true,
    assertTransportCurrent: () => undefined,
    snapshotTransport: () => ({
      origin: 'https://group-photo.test',
      headers: { Authorization: 'Bearer test-only' },
      password: 'test-only',
      transportRevision: 1,
      buildUrl: (path: string) => `https://group-photo.test/api/v1${path}`,
    }),
  } as unknown as HttpClient;
  return { http, remove, pinTransport };
}

describe('exact iMessage group photo service', () => {
  let db: AppDatabase;
  let raw: Database.Database;

  beforeEach(async () => {
    uploadRegistry.cancelAll();
    await uploadRegistry.awaitIdle();
    ({ db, raw } = await createTestDb());
    seedGroup(raw);
  });

  afterEach(async () => {
    uploadRegistry.cancelAll();
    await uploadRegistry.awaitIdle();
    raw.close();
  });

  it('registers before its first await, pins before picker use, and consumes one tempGuid once', async () => {
    const transport = fakeHttp();
    const upload = jest.fn<ReturnType<GroupPhotoUploader>, Parameters<GroupPhotoUploader>>(
      async (input) => {
        input.assertNetworkStart();
        input.onDispatch();
        return { updated: true, guid: CHAT_GUID, operation: 'set' };
      },
    );

    const preparing = prepareExactIMessageGroupPhotoSet(
      db,
      transport.http,
      CHAT_GUID,
      upload,
      undefined,
      capability(),
    );
    expect(uploadRegistry.size).toBe(1);
    const prepared = await preparing;
    expect(prepared).not.toBeNull();
    expect(transport.pinTransport).toHaveBeenCalledTimes(1);

    const result = await prepared!.submit(PHOTO);
    expect(result).toMatchObject({
      status: 'accepted',
      operation: 'set',
      guid: CHAT_GUID,
      tempGuid: prepared!.tempGuid,
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0]).toMatchObject({
      chatGuid: CHAT_GUID,
      tempGuid: prepared!.tempGuid,
      image: PHOTO,
    });
    await expect(prepared!.submit(PHOTO)).resolves.toMatchObject({ status: 'rejected' });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(uploadRegistry.size).toBe(0);
  });

  it('holds one shared set/remove lane and releases it when the picker grant is cancelled', async () => {
    const transport = fakeHttp();
    const upload: GroupPhotoUploader = async (input) => {
      input.onDispatch();
      return { updated: true, guid: CHAT_GUID, operation: 'set' };
    };
    const first = await prepareExactIMessageGroupPhotoSet(
      db,
      transport.http,
      CHAT_GUID,
      upload,
      undefined,
      capability(),
    );
    expect(first).not.toBeNull();

    await expect(
      removeExactIMessageGroupPhoto(
        db,
        transport.http,
        { chatGuid: CHAT_GUID },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected', operation: 'remove' });
    expect(transport.remove).not.toHaveBeenCalled();

    first!.cancel();
    await expect(
      removeExactIMessageGroupPhoto(
        db,
        transport.http,
        { chatGuid: CHAT_GUID },
        undefined,
        capability(),
      ),
    ).resolves.toMatchObject({ status: 'accepted', operation: 'remove', guid: CHAT_GUID });
    expect(transport.remove).toHaveBeenCalledTimes(1);
  });

  it('fails closed before picker/network without capability or complete local iMessage proof', async () => {
    const transport = fakeHttp();
    const upload = jest.fn<ReturnType<GroupPhotoUploader>, Parameters<GroupPhotoUploader>>();

    await expect(
      prepareExactIMessageGroupPhotoSet(
        db,
        transport.http,
        CHAT_GUID,
        upload,
        undefined,
        capability(false),
      ),
    ).resolves.toBeNull();

    const prepared = await prepareExactIMessageGroupPhotoSet(
      db,
      transport.http,
      CHAT_GUID,
      upload,
      undefined,
      capability(),
    );
    expect(prepared).not.toBeNull();
    raw
      .prepare("UPDATE handles SET service = 'SMS' WHERE id = (SELECT MIN(id) FROM handles)")
      .run();
    await expect(prepared!.submit(PHOTO)).resolves.toMatchObject({ status: 'rejected' });
    await expect(
      prepareExactIMessageGroupPhotoSet(
        db,
        transport.http,
        CHAT_GUID,
        upload,
        undefined,
        capability(),
      ),
    ).resolves.toBeNull();
    expect(upload).not.toHaveBeenCalled();
    expect(uploadRegistry.size).toBe(0);
  });

  it('invalidates the prepared grant when its exact capability owner changes in the picker', async () => {
    const transport = fakeHttp();
    const upload = jest.fn<ReturnType<GroupPhotoUploader>, Parameters<GroupPhotoUploader>>();
    let current = true;
    const source: RcsCapabilityLease = {
      kind: 'session',
      origin: 'https://group-photo.test',
      revision: 1,
      serverInfo: ServerInfo.parse({
        version: 'test',
        supports_imessage_group_photo: true,
      }),
      isCurrent: () => current,
      publish: () => false,
    };
    const prepared = await prepareExactIMessageGroupPhotoSet(
      db,
      transport.http,
      CHAT_GUID,
      upload,
      undefined,
      source,
    );
    expect(prepared).not.toBeNull();

    current = false;
    await expect(prepared!.submit(PHOTO)).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    expect(upload).not.toHaveBeenCalled();
    expect(uploadRegistry.size).toBe(0);
  });

  it('reports post-dispatch ambiguity without replay and keeps reviewed refusal definite', async () => {
    const transport = fakeHttp();
    const preDispatch = jest.fn<ReturnType<GroupPhotoUploader>, Parameters<GroupPhotoUploader>>(
      async () => {
        throw new ApiError('local_file', 'unreadable before native dispatch');
      },
    );
    const before = await prepareExactIMessageGroupPhotoSet(
      db,
      transport.http,
      CHAT_GUID,
      preDispatch,
      undefined,
      capability(),
    );
    await expect(before!.submit(PHOTO)).resolves.toMatchObject({ status: 'rejected' });
    expect(preDispatch).toHaveBeenCalledTimes(1);

    const uncertain: GroupPhotoUploader = async (input) => {
      input.onDispatch();
      throw new ApiError('no_connection', 'response lost');
    };
    const first = await prepareExactIMessageGroupPhotoSet(
      db,
      transport.http,
      CHAT_GUID,
      uncertain,
      undefined,
      capability(),
    );
    await expect(first!.submit(PHOTO)).resolves.toMatchObject({
      status: 'outcome-unknown',
      tempGuid: first!.tempGuid,
    });

    const rejected = jest.fn<ReturnType<GroupPhotoUploader>, Parameters<GroupPhotoUploader>>(
      async (input) => {
        input.onDispatch();
        throw ApiError.fromStatus(409, 'rejected', undefined, 'imessage_group_photo_rejected');
      },
    );
    const second = await prepareExactIMessageGroupPhotoSet(
      db,
      transport.http,
      CHAT_GUID,
      rejected,
      undefined,
      capability(),
    );
    await expect(second!.submit(PHOTO)).resolves.toMatchObject({ status: 'rejected' });
    expect(rejected).toHaveBeenCalledTimes(1);
  });
});
