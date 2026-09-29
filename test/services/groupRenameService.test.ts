import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient, RequestOptions } from '@core/api/http';
import { ServerInfo } from '@core/models';
import type { AppDatabase } from '@db/types';
import {
  fixedRcsCapabilitySource,
  type RcsCapabilityLease,
} from '@/services/send/rcsAttemptCapability';
import { renameExactIMessageGroup } from '@/services/groupRenameService';
import { createTestDb } from '../support/testDb';

const CHAT_GUID = 'iMessage;+;chat123456789';

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
    ServerInfo.parse({ version: 'test', supports_imessage_group_rename: enabled }),
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
      origin: 'https://rename.test',
      headers: {},
      password: 'test',
      transportRevision: 1,
      buildUrl: (path: string) => `https://rename.test/api/v1${path}`,
    }),
  } as unknown as HttpClient;
  return { http, post };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('renameExactIMessageGroup', () => {
  let db: AppDatabase;
  let raw: Database.Database;

  beforeEach(async () => {
    ({ db, raw } = await createTestDb());
    seedGroup(raw);
  });

  afterEach(() => raw.close());

  it('sends one exact request with one generated identity and accepts the matching result', async () => {
    const transport = fakeHttp(async (options) => ({
      renamed: true,
      guid: CHAT_GUID,
      displayName: (options.json as { displayName: string }).displayName,
    }));

    const result = await renameExactIMessageGroup(
      db,
      transport.http,
      { chatGuid: CHAT_GUID, displayName: 'Road Trip' },
      undefined,
      capability(),
    );

    expect(result).toMatchObject({
      status: 'accepted',
      guid: CHAT_GUID,
      displayName: 'Road Trip',
      tempGuid: expect.stringMatching(/^temp-/),
    });
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post.mock.calls[0]).toEqual([
      '/chat/iMessage%3B%2B%3Bchat123456789/rename',
      expect.anything(),
      {
        captureErrorDetail: true,
        retry: false,
        json: { displayName: 'Road Trip', tempGuid: result.tempGuid },
      },
    ]);
  });

  it.each([
    'imessage_group_rename_invalid_target',
    'imessage_group_rename_unavailable',
    'imessage_group_rename_rejected',
  ])('returns a definite %s refusal after exactly one attempt', async (serverErrorType) => {
    const transport = fakeHttp(async () => {
      throw ApiError.fromStatus(409, 'not renamed', undefined, serverErrorType);
    });

    await expect(
      renameExactIMessageGroup(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, displayName: 'Keep This Name' },
        undefined,
        capability(),
      ),
    ).resolves.toMatchObject({ status: 'rejected', tempGuid: expect.stringMatching(/^temp-/) });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it.each(['imessage_group_rename_outcome_unknown', 'idempotency_outcome_unknown'])(
    'returns %s as outcome unknown without replaying it',
    async (serverErrorType) => {
      const transport = fakeHttp(async () => {
        throw ApiError.fromStatus(500, 'unknown', undefined, serverErrorType);
      });

      await expect(
        renameExactIMessageGroup(
          db,
          transport.http,
          { chatGuid: CHAT_GUID, displayName: 'Maybe Renamed' },
          undefined,
          capability(),
        ),
      ).resolves.toMatchObject({
        status: 'outcome-unknown',
        tempGuid: expect.stringMatching(/^temp-/),
      });
      expect(transport.post).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses capability loss or incomplete participant proof before HTTP', async () => {
    const transport = fakeHttp(async () => ({
      renamed: true,
      guid: CHAT_GUID,
      displayName: 'Must Not Send',
    }));

    await expect(
      renameExactIMessageGroup(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, displayName: '   ' },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });

    await expect(
      renameExactIMessageGroup(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, displayName: 'Must Not Send' },
        undefined,
        capability(false),
      ),
    ).resolves.toEqual({ status: 'rejected' });

    raw
      .prepare("UPDATE handles SET service = 'SMS' WHERE id = (SELECT MIN(id) FROM handles)")
      .run();
    await expect(
      renameExactIMessageGroup(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, displayName: 'Must Not Send' },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).not.toHaveBeenCalled();
  });

  it('refuses a second submission while the first request is in flight', async () => {
    const response = deferred<unknown>();
    const started = deferred<void>();
    const transport = fakeHttp(async () => {
      started.resolve();
      return response.promise;
    });
    const first = renameExactIMessageGroup(
      db,
      transport.http,
      { chatGuid: CHAT_GUID, displayName: 'First Name' },
      undefined,
      capability(),
    );
    await started.promise;

    await expect(
      renameExactIMessageGroup(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, displayName: 'Second Name' },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).toHaveBeenCalledTimes(1);

    response.resolve({ renamed: true, guid: CHAT_GUID, displayName: 'First Name' });
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
    const source: RcsCapabilityLease = {
      kind: 'session',
      origin: 'https://rename.test',
      revision: 1,
      serverInfo: ServerInfo.parse({
        version: 'test',
        supports_imessage_group_rename: true,
      }),
      isCurrent: () => current,
      publish: () => false,
    };
    const result = renameExactIMessageGroup(
      db,
      transport.http,
      { chatGuid: CHAT_GUID, displayName: 'Late Name' },
      undefined,
      source,
    );
    await started.promise;
    current = false;
    response.resolve({ renamed: true, guid: CHAT_GUID, displayName: 'Late Name' });

    await expect(result).resolves.toMatchObject({
      status: 'outcome-unknown',
      tempGuid: expect.stringMatching(/^temp-/),
    });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('retires a late success as outcome-unknown after its account guard retires', async () => {
    const response = deferred<unknown>();
    const started = deferred<void>();
    const transport = fakeHttp(async () => {
      started.resolve();
      return response.promise;
    });
    let accountCurrent = true;
    const result = renameExactIMessageGroup(
      db,
      transport.http,
      { chatGuid: CHAT_GUID, displayName: 'Old Account Name' },
      () => accountCurrent,
      capability(),
    );
    await started.promise;
    accountCurrent = false;
    response.resolve({ renamed: true, guid: CHAT_GUID, displayName: 'Old Account Name' });

    await expect(result).resolves.toMatchObject({
      status: 'outcome-unknown',
      tempGuid: expect.stringMatching(/^temp-/),
    });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });
});
